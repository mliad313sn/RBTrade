import type { Role } from '@kora/domain';
import { describe, expect, it } from 'vitest';

import type { Principal } from './principal';
import { UserProvisioner } from './user-provisioner.service';

/** IRTC R4-10: an identity-provider token cannot grant `trader` without a passed appropriateness assessment. */
function setup(passed: boolean) {
  const synced: Role[][] = [];
  const client = {
    query: async (sql: string) => ({
      rows: [],
      rowCount: /questionnaire_attempts/.test(sql) && passed ? 1 : 0,
    }),
  };
  const provisioner = new UserProvisioner(
    { auth: { provider: 'keycloak' } } as never,
    {
      tx: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
      query: async () => [],
    } as never,
    {
      findById: async () => ({ id: 'u1' }),
      setRoles: async (_c: unknown, _id: string, roles: Role[]) => {
        synced.push(roles);
      },
      create: async () => ({ id: 'u1' }),
    } as never,
    { record: async () => ({ id: '1' }) } as never,
  );
  return { provisioner, synced };
}

const principal = (roles: Role[]): Principal =>
  ({ sub: 'u1', roles, mfa: true }) as unknown as Principal;

describe('UserProvisioner (Keycloak role sync)', () => {
  it('drops trader from the token and the local roles when there is no passed assessment', async () => {
    const { provisioner, synced } = setup(false);
    const p = principal(['novice', 'trader']);
    await provisioner.ensure(p);
    expect(p.roles).toEqual(['novice']);
    expect(synced).toEqual([['novice']]);
  });

  it('keeps trader when the user passed the assessment', async () => {
    const { provisioner, synced } = setup(true);
    const p = principal(['novice', 'trader']);
    await provisioner.ensure(p);
    expect(p.roles).toEqual(['novice', 'trader']);
    expect(synced).toEqual([['novice', 'trader']]);
  });
});
