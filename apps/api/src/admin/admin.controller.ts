import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Put,
  Res,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PRIVILEGED_GRANT_ROLES, ROLES, rolesConflict } from '@kora/domain';
import type { Response } from 'express';
import { z } from 'zod';

import { AuditService } from '../audit/audit.service';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { SessionsService } from '../auth/sessions.service';
import { UsersRepository } from '../auth/users.repository';
import { openApiSchema, ZodValidationPipe } from '../common/zod';
import { DbService, type Queryable } from '../db/db.service';
import { FourEyesStore } from '../governance/four-eyes.store';

const SetRolesSchema = z
  .object({
    roles: z.array(z.enum(ROLES)).min(1).max(6),
    /** Required when the change adds a privileged role (it becomes a four-eyes request). */
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .strict();

@ApiTags('admin')
@Controller('admin/users')
@Roles('admin')
export class AdminController {
  constructor(
    private readonly db: DbService,
    private readonly users: UsersRepository,
    private readonly audit: AuditService,
    private readonly sessions: SessionsService,
    private readonly fourEyes: FourEyesStore,
  ) {}

  @Get()
  async list() {
    const rows = await this.users.list();
    return rows.map((u) => ({
      id: u.id,
      email: u.email,
      displayName: u.display_name,
      roles: u.roles,
      mfaEnabled: u.mfa_enabled,
      status: u.status,
    }));
  }

  @Put(':id/roles')
  @ApiOperation({
    summary:
      "Replace a user's roles (audited). Adding admin, risk_officer, auditor or trader opens a four-eyes role_grant request (202) that a second admin approves; nobody changes their own roles upwards. Users with non-novice roles must enrol MFA at next login.",
  })
  @ApiBody({ schema: openApiSchema(SetRolesSchema) })
  async setRoles(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(SetRolesSchema)) body: z.infer<typeof SetRolesSchema>,
    @Res({ passthrough: true }) res: Response,
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
      throw new BadRequestException({
        error: 'self_demotion',
        message: 'You cannot remove your own admin role',
      });
    }
    return this.db.tx(async (c) => {
      const user = await this.users.findById(id, c);
      if (!user) throw new NotFoundException({ error: 'not_found', message: 'User not found' });
      const before = await this.users.roles(id, c);
      const added = roles.filter((r) => !before.includes(r));
      // IRTC R4-02: nobody grants themselves a role.
      if (id === p.sub && added.length)
        throw new ForbiddenException({
          error: 'self_grant',
          message: 'You cannot grant yourself a role. Another admin must do it.',
        });
      const privileged = added.filter((r) => PRIVILEGED_GRANT_ROLES.includes(r));
      if (privileged.length) {
        // IRTC R4-02/R4-10: a privileged grant is a four-eyes request, with a reason.
        if (!body.reason)
          throw new BadRequestException({
            error: 'reason_required',
            message: `Granting ${privileged.join(', ')} needs a reason; a second admin approves it.`,
          });
        const passed = added.includes('trader') ? await this.passedAppropriateness(id, c) : null;
        const row = await this.fourEyes.create(
          {
            kind: 'role_grant',
            subjectType: 'user',
            subjectId: id,
            payload: {
              userId: id,
              before,
              after: roles,
              added,
              ...(passed === null
                ? {}
                : { appropriatenessPassed: passed, appropriatenessOverride: !passed }),
            },
            reason: body.reason,
            requestedBy: p.sub,
          },
          c,
        );
        res.status(202);
        return {
          id,
          status: 'pending',
          kind: 'role_grant',
          requestId: row.id,
          roles: before,
          requested: roles,
        };
      }
      await this.users.setRoles(c, id, roles, p.sub);
      // Goal 10: tokens issued before the change carry the old roles; end them.
      await this.sessions.invalidateAll(id, c);
      await this.audit.record(
        {
          actorId: p.sub,
          actorType: 'user',
          action: 'admin.roles_changed',
          entity: 'user',
          entityId: id,
          payload: { before, after: roles },
        },
        c,
      );
      return { id, roles };
    });
  }

  private async passedAppropriateness(userId: string, c: Queryable): Promise<boolean> {
    const r = await c.query(
      "SELECT 1 FROM questionnaire_attempts WHERE user_id = $1 AND questionnaire_id = 'appropriateness' AND passed LIMIT 1",
      [userId],
    );
    return (r.rowCount ?? 0) > 0;
  }
}
