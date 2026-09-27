import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AUDIT_READ_ALL_ROLES,
  hasAnyRole,
  orderTypesFor,
  ROBOT_BUILDER_ROLES,
  UpdatePreferencesSchema,
  type UpdatePreferences,
  type UserPreferences,
} from '@kora/domain';

import { AuditService } from '../audit/audit.service';
import { CurrentPrincipal } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { UsersRepository } from '../auth/users.repository';
import { openApiSchema, ZodValidationPipe } from '../common/zod';
import { DbService } from '../db/db.service';
import { PreferencesRepository } from './preferences.repository';

function capabilities(p: Principal, prefs: UserPreferences) {
  return {
    orderTypes: orderTypesFor(prefs.viewMode),
    robotBuilder: hasAnyRole(p.roles, ROBOT_BUILDER_ROLES),
    auditReadAll: hasAnyRole(p.roles, AUDIT_READ_ALL_ROLES),
    tradingEnvironment: 'PAPER' as const,
  };
}

@ApiTags('me')
@Controller('me')
export class MeController {
  constructor(
    private readonly db: DbService,
    private readonly users: UsersRepository,
    private readonly prefs: PreferencesRepository,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Current user, roles, preferences and server-side capabilities' })
  async me(@CurrentPrincipal() p: Principal) {
    const user = await this.users.findById(p.sub);
    const preferences = await this.prefs.get(p.sub, p.roles);
    return {
      user: {
        id: p.sub,
        email: user?.email ?? p.email,
        displayName: user?.display_name ?? p.email ?? 'KORA user',
      },
      roles: p.roles,
      mfa: p.mfa,
      preferences,
      capabilities: capabilities(p, preferences),
    };
  }

  @Get('preferences')
  getPreferences(@CurrentPrincipal() p: Principal) {
    return this.prefs.get(p.sub, p.roles);
  }

  @Put('preferences')
  @ApiOperation({ summary: 'Update view mode, theme, colour convention or hotkeys (audited)' })
  @ApiBody({ schema: openApiSchema(UpdatePreferencesSchema) })
  async updatePreferences(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(UpdatePreferencesSchema)) patch: UpdatePreferences,
  ) {
    const { after } = await this.db.tx(async (c) => {
      const r = await this.prefs.update(c, p.sub, p.roles, patch);
      await this.audit.record(
        {
          actorId: p.sub,
          actorType: 'user',
          action: 'preferences.updated',
          entity: 'user_preferences',
          entityId: p.sub,
          payload: {
            changed: patch,
            previous: Object.fromEntries(
              Object.keys(patch).map((k) => [k, r.before[k as keyof UserPreferences]]),
            ),
          },
        },
        c,
      );
      return r;
    });
    return { preferences: after, capabilities: capabilities(p, after) };
  }
}
