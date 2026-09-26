import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ROLES, rolesConflict } from '@kora/domain';
import { z } from 'zod';

import { AuditService } from '../audit/audit.service';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { SessionsService } from '../auth/sessions.service';
import { UsersRepository } from '../auth/users.repository';
import { openApiSchema, ZodValidationPipe } from '../common/zod';
import { DbService } from '../db/db.service';

const SetRolesSchema = z.object({ roles: z.array(z.enum(ROLES)).min(1).max(6) }).strict();

@ApiTags('admin')
@Controller('admin/users')
@Roles('admin')
export class AdminController {
  constructor(
    private readonly db: DbService,
    private readonly users: UsersRepository,
    private readonly audit: AuditService,
    private readonly sessions: SessionsService,
  ) {}

  @Get()
  async list() {
    const rows = await this.users.list();
    return rows.map((u) => ({ id: u.id, email: u.email, displayName: u.display_name, roles: u.roles, mfaEnabled: u.mfa_enabled, status: u.status }));
  }

  @Put(':id/roles')
  @ApiOperation({ summary: 'Replace a user\'s roles (audited). Users with non-novice roles must enrol MFA at next login.' })
  @ApiBody({ schema: openApiSchema(SetRolesSchema) })
  async setRoles(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(SetRolesSchema)) body: z.infer<typeof SetRolesSchema>,
  ) {
    const roles = [...new Set(body.roles)];
    // Goal 09 segregation of duties: the internal auditor (3rd line) holds no operating role.
    const conflict = rolesConflict(roles);
    if (conflict) {
      throw new BadRequestException({
        error: 'segregation_of_duties',
        message: `Segregation of duties: ${conflict[0]} cannot be combined with ${conflict[1]}.`,
      });
    }
    if (id === p.sub && !roles.includes('admin')) {
      throw new BadRequestException({ error: 'self_demotion', message: 'You cannot remove your own admin role' });
    }
    return this.db.tx(async (c) => {
      const user = await this.users.findById(id, c);
      if (!user) throw new NotFoundException({ error: 'not_found', message: 'User not found' });
      const before = await this.users.roles(id, c);
      await this.users.setRoles(c, id, roles, p.sub);
      // Goal 10: tokens issued before the change carry the old roles; end them.
      await this.sessions.invalidateAll(id, c);
      await this.audit.record({ actorId: p.sub, actorType: 'user', action: 'admin.roles_changed', entity: 'user', entityId: id, payload: { before, after: roles } }, c);
      return { id, roles };
    });
  }
}
