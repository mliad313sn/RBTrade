import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Role } from '@kora/domain';

import type { KoraRequest } from '../common/request';
import type { Principal } from './principal';

export const IS_PUBLIC = 'kora:isPublic';
export const ROLES = 'kora:roles';

/** Route needs no authentication. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

/** Route needs any one of the roles. Non-novice roles always imply MFA (global rule). */
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES, roles);

export const CurrentPrincipal = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Principal => {
    const req = ctx.switchToHttp().getRequest<KoraRequest>();
    if (!req.principal) throw new Error('CurrentPrincipal used on a public route');
    return req.principal;
  },
);
