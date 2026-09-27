import { Inject, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { DbService } from '../db/db.service';
import type { Principal } from './principal';
import { UsersRepository } from './users.repository';

/**
 * Just-in-time provisioning for externally managed identities (Keycloak): the local users row
 * (for preferences and FKs) is created on the first authenticated request and roles are synced from
 * the token. No-op for the dev IdP, whose users already exist. `trader` is kept only with a passed
 * appropriateness assessment (IRTC R4-10); other realm roles are managed in the IdP, whose own
 * role-assignment governance must mirror the four-eyes rule (ADR 0009 §4a).
 */
@Injectable()
export class UserProvisioner {
  private readonly seen = new Map<string, string>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly users: UsersRepository,
    private readonly audit: AuditService,
  ) {}

  async ensure(p: Principal): Promise<void> {
    if (this.config.auth.provider !== 'keycloak') return;
    const key = p.roles.join(',');
    if (this.seen.get(p.sub) === key) return;
    await this.db.tx(async (c) => {
      // IRTC R4-10: `trader` comes only from the appropriateness assessment. A realm role mapping
      // cannot grant it: without a local passed attempt it is removed from this request's principal
      // and from the synced roles.
      if (p.roles.includes('trader')) {
        const passed = await c.query(
          "SELECT 1 FROM questionnaire_attempts WHERE user_id = $1 AND questionnaire_id = 'appropriateness' AND passed LIMIT 1",
          [p.sub],
        );
        if (!passed.rowCount) this.dropTrader(p);
      }
      const existing = await this.users.findById(p.sub, c);
      if (!existing) {
        await this.users.create(c, {
          id: p.sub,
          email: p.email ?? `${p.sub}@keycloak.invalid`,
          displayName: p.email ?? 'KORA user',
          passwordHash: null,
          roles: p.roles,
          provider: 'keycloak',
        });
        await this.audit.record(
          {
            actorId: p.sub,
            actorType: 'system',
            action: 'auth.user_provisioned',
            entity: 'user',
            entityId: p.sub,
            payload: { provider: 'keycloak', roles: p.roles },
          },
          c,
        );
      } else {
        await this.users.setRoles(c, p.sub, p.roles, null);
      }
    });
    // A dropped trader role is re-checked on every request (it appears once the user passes).
    if (p.roles.join(',') === key) this.seen.set(p.sub, key);
  }

  private dropTrader(p: Principal): void {
    const kept = p.roles.filter((r) => r !== 'trader');
    p.roles.splice(0, p.roles.length, ...kept);
  }
}
