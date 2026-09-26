import { Controller, Get, Headers, Res, UnauthorizedException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';

import { Public } from '../auth/decorators';
import { MetricsService } from './metrics.service';

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Prometheus scrape endpoint. With `KORA_METRICS_TOKEN` set (enforced outside dev/test: without
 * a token the endpoint refuses every scrape) the scraper must send `Authorization: Bearer <token>`.
 */
@ApiExcludeController()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Public()
  @SkipThrottle()
  async scrape(@Headers('authorization') auth: string | undefined, @Res() res: Response) {
    const token = process.env.KORA_METRICS_TOKEN?.trim();
    // Goal 10 (S9): fail closed. Outside dev/test the endpoint answers only with a configured token.
    const env = process.env.KORA_ENV ?? 'dev';
    if (!token && env !== 'dev' && env !== 'test')
      throw new UnauthorizedException({ error: 'unauthorized', message: 'Metrics are disabled until KORA_METRICS_TOKEN is set.' });
    if (token && !sameToken(auth ?? '', `Bearer ${token}`))
      throw new UnauthorizedException({
        error: 'unauthorized',
        message: 'Metrics token required.',
      });
    res.setHeader('content-type', this.metrics.registry.contentType);
    res.send(await this.metrics.registry.metrics());
  }
}
