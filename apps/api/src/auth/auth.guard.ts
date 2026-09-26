import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { hasAnyRole, requiresMfa, type Role } from '@kora/domain';

import type { KoraRequest } from '../common/request';
import { ACCESS_COOKIE } from './cookies';
import { IS_PUBLIC, ROLES } from './decorators';
import { TokenService } from './token.service';
import { UserProvisioner } from './user-provisioner.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_HEADER = 'x-kora-csrf';

/**
 * Global guard (ADR 0101):
 * 1. CSRF: cookie-authenticated or anonymous unsafe requests need the x-kora-csrf header.
 * 2. Authentication via Bearer header or the kora_at cookie.
 * 3. MFA: any non-novice role without amr=otp is rejected (global, cannot be forgotten per route).
 * 4. @Roles(): caller needs any one of the listed roles.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly provisioner: UserProvisioner,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<KoraRequest>();
    const targets = [ctx.getHandler(), ctx.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets) ?? false;

    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
    const token = bearer ?? req.cookies?.[ACCESS_COOKIE] ?? null;

    if (!SAFE_METHODS.has(req.method) && !bearer && req.headers[CSRF_HEADER] !== '1') {
      throw new ForbiddenException({ error: 'csrf', message: `Missing ${CSRF_HEADER} header` });
    }

    if (isPublic) return true;
    if (!token) throw new UnauthorizedException({ error: 'unauthenticated', message: 'Sign in required' });

    let principal;
    try {
      principal = await this.tokens.verifyAccessToken(token);
    } catch {
      throw new UnauthorizedException({ error: 'invalid_token', message: 'Session expired or invalid. Sign in again.' });
    }
    if (requiresMfa(principal.roles) && !principal.mfa) {
      throw new ForbiddenException({ error: 'mfa_required', message: 'This account needs two-factor authentication.' });
    }
    await this.provisioner.ensure(principal);
    req.principal = principal;

    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, targets);
    if (required && !hasAnyRole(principal.roles, required)) {
      throw new ForbiddenException({
        error: 'forbidden',
        message: 'Your account type does not include this feature.',
        requiredRoles: required,
      });
    }
    return true;
  }
}
