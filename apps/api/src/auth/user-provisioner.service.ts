import { Inject, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { DbService } from '../db/db.service';
import type { Principal } from './principal';
import { UsersRepository } from './users.repository';

/**
 * Just-in-time provisioning for externally managed identities (Keycloak): the local users row
 * (for preferences and FKs) is created on the first authenticated request and roles are synced from
 * the token. No-op for the dev IdP, whose users already exist.
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
        await this.audit.record({ actorId: p.sub, actorType: 'system', action: 'auth.user_provisioned', entity: 'user', entityId: p.sub, payload: { provider: 'keycloak', roles: p.roles } }, c);
      } else {
        await this.users.setRoles(c, p.sub, p.roles, null);
      }
    });
    this.seen.set(p.sub, key);
  }
}
