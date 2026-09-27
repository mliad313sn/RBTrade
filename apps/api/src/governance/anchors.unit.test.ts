import { createPublicKey, generateKeyPairSync, sign, type JsonWebKey } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AnchorsService,
  anchorMessage,
  keyIdOf,
  verifyAnchorSignature,
  witnessOf,
} from './anchors.service';
import { loadGovernanceConfig } from './governance-config';

/** IRTC R4-07: anchors are verified against pinned keys, witness the head, and the WORM copy is read back. */
function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;
  return { privateKey, jwk, keyId: keyIdOf(jwk) };
}

function signed(
  k: ReturnType<typeof keypair>,
  fields = {
    headId: '10',
    headHash: 'a'.repeat(64),
    eventCount: '10',
    anchoredAt: '2026-09-27T00:00:00.000Z',
  },
) {
  const signature = sign('sha256', Buffer.from(anchorMessage(fields)), {
    key: k.privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return { ...fields, keyId: k.keyId, signature };
}

describe('audit anchors (IRTC R4-07)', () => {
  const service = keypair();
  const attacker = keypair();
  const trusted = new Map([[service.keyId, createPublicKey({ key: service.jwk, format: 'jwk' })]]);

  it('a row signed with a key that is not pinned is never valid, whatever public key the row carries', () => {
    expect(verifyAnchorSignature(signed(service), trusted)).toEqual({
      signatureValid: true,
      trustedKey: true,
    });
    expect(verifyAnchorSignature(signed(attacker), trusted)).toEqual({
      signatureValid: false,
      trustedKey: false,
    });
    // The attacker labels the row with the service key id but signs with their own key.
    expect(verifyAnchorSignature({ ...signed(attacker), keyId: service.keyId }, trusted)).toEqual({
      signatureValid: false,
      trustedKey: true,
    });
  });

  it('the latest anchor witnesses the head: a deleted tail is truncated, a rewrite is a mismatch', () => {
    const a = {
      id: '1',
      headId: '200',
      headHash: 'b'.repeat(64),
      eventCount: 200,
      anchoredAt: 't',
    };
    expect(witnessOf(a, { count: 205, hashAtHead: 'b'.repeat(64) })).toMatchObject({
      truncated: false,
      mismatch: false,
      eventsAfterLastAnchor: 5,
    });
    expect(witnessOf(a, { count: 196, hashAtHead: null })).toMatchObject({ truncated: true });
    expect(witnessOf(a, { count: 199, hashAtHead: 'b'.repeat(64) })).toMatchObject({
      truncated: true,
    });
    expect(witnessOf(a, { count: 205, hashAtHead: 'c'.repeat(64) })).toMatchObject({
      truncated: false,
      mismatch: true,
    });
  });

  it('the WORM copy is read back: a file anchor missing from the database or the chain is reported', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kora-anchors-'));
    try {
      const cfg = loadGovernanceConfig({
        KORA_ENV: 'test',
        KORA_AUDIT_ANCHOR_DIR: dir,
      } as NodeJS.ProcessEnv);
      const anchors: Array<Record<string, unknown>> = [];
      const chain = new Map([['5', 'd'.repeat(64)]]);
      const db = {
        query: async (sql: string, params: unknown[] = []) => {
          if (sql.includes('INSERT INTO audit_anchors')) {
            const row = {
              id: String(anchors.length + 1),
              head_id: params[0],
              head_hash: params[1],
              event_count: params[2],
              algorithm: 'ES256',
              key_id: params[3],
              public_jwk: JSON.parse(String(params[4])),
              signature: params[5],
              created_by: params[6],
              anchored_at: new Date(String(params[7])),
            };
            anchors.push(row);
            return [row];
          }
          if (sql.includes('FROM (SELECT 1) one'))
            return [{ id: '5', hash: 'd'.repeat(64), n: '5' }];
          if (sql.includes('FROM audit_anchors')) return anchors;
          if (sql.includes('FROM audit_events WHERE id = ANY'))
            return [...chain]
              .filter(([id]) => (params[0] as string[]).includes(id))
              .map(([id, hash]) => ({ id, hash }));
          return [];
        },
      };
      const svc = new AnchorsService(cfg, db as never, { record: async () => ({}) } as never);
      await svc.anchor('user:admin');
      expect(await svc.wormCheck()).toMatchObject({
        configured: true,
        fileAnchors: 1,
        invalidSignatures: 0,
        missingInDatabase: 0,
        notMatchingChain: 0,
      });
      // An insider drops the anchor rows together with a rewritten chain: the file still has them.
      anchors.length = 0;
      chain.set('5', 'e'.repeat(64));
      expect(await svc.wormCheck()).toMatchObject({
        fileAnchors: 1,
        missingInDatabase: 1,
        notMatchingChain: 1,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the anchoring job runs by default outside tests; NODE_ENV=production needs a real key (R4-12)', () => {
    expect(loadGovernanceConfig({ KORA_ENV: 'dev' } as NodeJS.ProcessEnv).anchorIntervalMs).toBe(
      86_400_000,
    );
    expect(loadGovernanceConfig({ KORA_ENV: 'test' } as NodeJS.ProcessEnv).anchorIntervalMs).toBe(
      0,
    );
    expect(() =>
      loadGovernanceConfig({ KORA_ENV: 'dev', NODE_ENV: 'production' } as NodeJS.ProcessEnv),
    ).toThrow(/KORA_AUDIT_ANCHOR_JWK/);
  });
});
