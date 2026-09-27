import { describe, expect, it } from 'vitest';

import { canonicalJson, CanonicalJsonError, GENESIS_HASH, type AuditEvent } from './audit.js';
import { AuditChainVerifier, computeAuditHash, sha256Hex, verifyAuditChain } from './audit-hash.js';

describe('canonicalJson', () => {
  it('sorts keys deterministically at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 'x', null, true], c: false } })).toBe(
      '{"a":{"c":false,"d":[1,"x",null,true]},"b":1}',
    );
    expect(canonicalJson({ a: undefined, b: 'é"\n' })).toBe('{"b":"é\\"\\n"}');
    expect(canonicalJson(Object.create(null) as object)).toBe('{}');
  });
  it('rejects floats, NUL, non-plain objects and unsupported types', () => {
    expect(() => canonicalJson({ price: 1.1 })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(Number.NaN)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson('a\u0000b')).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(new Date())).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(() => 1)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(1n)).toThrow(CanonicalJsonError);
  });
});

function chain(n: number): AuditEvent[] {
  const out: AuditEvent[] = [];
  let prev = GENESIS_HASH;
  for (let i = 1; i <= n; i++) {
    const e = {
      id: String(i),
      ts: `2026-09-26T12:00:0${i}.000123Z`,
      actorId: 'u1',
      actorType: 'user' as const,
      action: 'test.event',
      entity: 'test',
      entityId: String(i),
      payload: { n: i, amount: '10.50' },
    };
    const hash = computeAuditHash(e, prev);
    out.push({ ...e, prevHash: prev, hash });
    prev = hash;
  }
  return out;
}

describe('hash chain', () => {
  it('matches a known SHA-256 vector', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
  it('verifies a clean chain', () => {
    const r = verifyAuditChain(chain(5));
    expect(r).toMatchObject({ valid: true, count: 5, firstBrokenId: null, reason: null });
    expect(r.headHash).toHaveLength(64);
    expect(verifyAuditChain([]).headHash).toBe(GENESIS_HASH);
  });
  it('detects a tampered payload with the first broken id', () => {
    const c = chain(5);
    c[2] = { ...c[2]!, payload: { n: 3, amount: '99.00' } };
    expect(verifyAuditChain(c)).toMatchObject({
      valid: false,
      firstBrokenId: '3',
      reason: 'hash_mismatch',
    });
  });
  it('detects a broken link and an id gap', () => {
    const c = chain(4);
    c[1] = { ...c[1]!, prevHash: 'f'.repeat(64) };
    expect(verifyAuditChain(c)).toMatchObject({ firstBrokenId: '2', reason: 'prev_hash_mismatch' });
    const g = chain(4);
    g.splice(1, 1);
    expect(verifyAuditChain(g)).toMatchObject({ firstBrokenId: '3', reason: 'id_gap' });
  });
  it('flags unhashable payloads as hash mismatch and stops after the first break', () => {
    const c = chain(3);
    c[0] = { ...c[0]!, payload: { x: 1.5 } };
    const v = new AuditChainVerifier();
    expect(v.push(c[0]!)).toBe(false);
    expect(v.push(c[1]!)).toBe(false);
    expect(v.result()).toMatchObject({ valid: false, firstBrokenId: '1', count: 1 });
  });
});

// IRTC R6-01: pin the hash spec (ADR 0102) with a known-answer vector computed independently of this
// implementation, and prove every hashed field is covered, so a refactor that drops a field or changes
// the canonicalisation fails CI instead of silently breaking verification of historical chains.
describe('audit hash spec (IRTC R6-01)', () => {
  const KAT_EVENT = {
    id: '1',
    ts: '2026-09-26T12:00:00.000000Z',
    actorId: 'u1',
    actorType: 'user' as const,
    action: 'test.event',
    entity: 'test',
    entityId: '1',
    payload: { amount: '10.50' },
  };
  // The exact canonical body from ADR 0102 (sorted keys, no whitespace), written out by hand.
  const KAT_BODY =
    '{"action":"test.event","actor_id":"u1","actor_type":"user","entity":"test","entity_id":"1",' +
    '"id":"1","payload":{"amount":"10.50"},"ts":"2026-09-26T12:00:00.000000Z"}';
  // sha256(KAT_BODY + 64 zeros), computed outside this code base (Python hashlib).
  const KAT_HASH = '8cd10597fd12fc73dedf4f0c8aa8520826084f849302bc9b36771df6d007618a';

  it('matches the pinned known-answer vector for a fixed event and the genesis prev hash', () => {
    expect(sha256Hex(KAT_BODY + GENESIS_HASH)).toBe(KAT_HASH);
    expect(computeAuditHash(KAT_EVENT, GENESIS_HASH)).toBe(KAT_HASH);
  });

  const variants: [string, Partial<typeof KAT_EVENT> | { entityId: null }][] = [
    ['id', { id: '2' }],
    ['ts', { ts: '2026-09-26T12:00:00.000001Z' }],
    ['actor_id', { actorId: 'u2' }],
    ['actor_type', { actorType: 'system' as never }],
    ['action', { action: 'test.forged' }],
    ['entity', { entity: 'other' }],
    ['entity_id', { entityId: '2' }],
    ['entity_id (null)', { entityId: null }],
    ['payload', { payload: { amount: '10.51' } }],
  ];
  for (const [field, patch] of variants) {
    it(`changing ${field} changes the hash and breaks verification`, () => {
      expect(
        computeAuditHash({ ...KAT_EVENT, ...patch } as typeof KAT_EVENT, GENESIS_HASH),
      ).not.toBe(KAT_HASH);
      const forged = {
        ...KAT_EVENT,
        ...patch,
        prevHash: GENESIS_HASH,
        hash: KAT_HASH,
      } as AuditEvent;
      expect(verifyAuditChain([forged])).toMatchObject({
        valid: false,
        firstBrokenId: forged.id,
        reason: 'hash_mismatch',
      });
    });
  }

  it('changing prev_hash changes the hash and breaks the link', () => {
    expect(computeAuditHash(KAT_EVENT, 'f'.repeat(64))).not.toBe(KAT_HASH);
    const c = chain(3);
    const forgedPrev = 'a'.repeat(64);
    c[1] = { ...c[1]!, prevHash: forgedPrev, hash: computeAuditHash(c[1]!, forgedPrev) };
    expect(verifyAuditChain(c)).toMatchObject({
      valid: false,
      firstBrokenId: '2',
      reason: 'prev_hash_mismatch',
    });
  });

  it('the untampered KAT event verifies', () => {
    expect(
      verifyAuditChain([{ ...KAT_EVENT, prevHash: GENESIS_HASH, hash: KAT_HASH }]),
    ).toMatchObject({
      valid: true,
      headHash: KAT_HASH,
    });
  });
});
