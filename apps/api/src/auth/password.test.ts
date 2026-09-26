import { describe, expect, it } from 'vitest';

import { dummyPasswordHash, hashPassword, verifyPassword } from './password';

describe('password hashing', () => {
  it('hashes and verifies with scrypt', async () => {
    const h = await hashPassword('correct horse battery', 16384);
    expect(h.startsWith('scrypt$16384$8$1$')).toBe(true);
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong horse battery', h)).toBe(false);
  });
  it('uses a unique salt per hash', async () => {
    expect(await hashPassword('same-password-123', 16384)).not.toBe(await hashPassword('same-password-123', 16384));
  });
  it('rejects malformed stored hashes', async () => {
    expect(await verifyPassword('x', 'bcrypt$abc')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$a$b$c$d$e')).toBe(false);
  });
  it('provides a stable dummy hash', async () => {
    expect(await dummyPasswordHash(16384)).toBe(await dummyPasswordHash(16384));
  });
});
