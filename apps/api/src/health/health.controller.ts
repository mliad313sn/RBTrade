import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { Public } from '../auth/decorators';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { DbService } from '../db/db.service';
import { RedisService } from '../db/redis.service';

type Check = { status: 'up' | 'down' | 'skipped'; latencyMs?: number; reason?: string };

async function timed(fn: () => Promise<boolean>, timeoutMs = 2000): Promise<Check> {
  const t0 = performance.now();
  try {
    const ok = await Promise.race([
      fn(),
      new Promise<boolean>((_, rej) =>
        setTimeout(() => rej(new Error('timeout')), timeoutMs).unref(),
      ),
    ]);
    return { status: ok ? 'up' : 'down', latencyMs: Math.round(performance.now() - t0) };
  } catch (e) {
    return {
      status: 'down',
      latencyMs: Math.round(performance.now() - t0),
      reason: (e as Error).message,
    };
  }
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly redis: RedisService,
  ) {}

  @Public()
  @Get()
  @ApiOperation({
    summary: 'Liveness + dependency status (db, redis, keycloak). 503 when db or redis is down.',
  })
  async health(@Res({ passthrough: true }) res: Response) {
    const [db, redis, keycloak] = await Promise.all([
      timed(async () => (await this.db.query<{ ok: number }>('SELECT 1 AS ok'))[0]?.ok === 1),
      timed(() => this.redis.ping()),
      this.config.auth.provider === 'keycloak'
        ? timed(
            async () =>
              (await fetch(`${this.config.auth.keycloak.issuer}/.well-known/openid-configuration`))
                .ok,
          )
        : Promise.resolve<Check>({
            status: 'skipped',
            reason: 'AUTH_PROVIDER=dev (built-in OIDC dev IdP in use)',
          }),
    ]);
    const healthy = db.status === 'up' && redis.status === 'up' && keycloak.status !== 'down';
    res.status(healthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: healthy ? 'ok' : 'degraded',
      service: 'kora-api',
      environment: this.config.tradingEnvironment,
      liveTradingEnabled: this.config.liveTradingEnabled,
      authProvider: this.config.auth.provider,
      checks: { db, redis, keycloak },
      time: new Date().toISOString(),
    };
  }
}
