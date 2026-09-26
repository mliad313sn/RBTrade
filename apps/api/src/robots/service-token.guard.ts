import { timingSafeEqual, createHash } from 'node:crypto';

import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

export const SERVICE_TOKEN_HEADER = 'x-kora-service-token';

/** The bot runner's shared secret (≥ 32 characters, from env or vault only). */
export function serviceToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const t = env.KORA_SERVICE_TOKEN?.trim() ?? '';
  return t.length >= 32 ? t : null;
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * Service authentication for `/internal/*` (bot runner → api). Constant-time comparison; the routes
 * refuse to work at all when no token is configured. Users' bearer tokens are not accepted here and
 * the service token is not accepted anywhere else.
 */
@Injectable()
export class ServiceTokenGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const expected = serviceToken();
    if (!expected)
      throw new ServiceUnavailableException({
        error: 'service_auth_not_configured',
        message: 'KORA_SERVICE_TOKEN is not configured (at least 32 characters).',
      });
    const got = ctx.switchToHttp().getRequest<Request>().header(SERVICE_TOKEN_HEADER) ?? '';
    if (!timingSafeEqual(digest(got), digest(expected)))
      throw new UnauthorizedException({
        error: 'invalid_service_token',
        message: 'Invalid service token.',
      });
    return true;
  }
}
