# ADR 0102 — Append-only, hash-chained audit log

- Status: Accepted (2026-09-26)
- Deciders: S3, S9, S8

## Decision

- Table `audit_events`:
  - `id bigint identity` (chain order);
  - `ts timestamptz` (µs, UTC, set by the DB via `clock_timestamp()`);
  - `actor_id text`;
  - `actor_type` (`user|robot|ai|system`);
  - `action`, `entity`, `entity_id`;
  - `payload jsonb`;
  - `prev_hash`, `hash` (hex SHA-256).
- `hash = sha256(canonical_json({id, ts, actor_id, actor_type, action, entity, entity_id, payload}) + prev_hash)`.
  - The genesis `prev_hash` is 64 zeros.
  - `ts` is rendered as `YYYY-MM-DDTHH:MM:SS.ffffffZ` by Postgres, both when writing and when verifying.
- **Canonical JSON:**
  - keys are sorted at every depth, with no whitespace;
  - strings use JSON escaping;
  - only safe integers are allowed as numbers. Floats are rejected, so decimals must be strings, which also enforces the no-float money rule.
- **Serialisation:** `AuditService.record()` runs in one transaction:
  - `pg_advisory_xact_lock(hashtext('kora.audit_chain'))`;
  - read the last hash;
  - `nextval` plus `clock_timestamp()`;
  - compute the hash;
  - insert.

  Callers can pass their own `PoolClient`, so the audit row commits atomically with the business change.
- **Immutability** has two layers:
  1. privileges: `kora_app` has only `SELECT, INSERT` on `audit_events`, and `UPDATE, DELETE, TRUNCATE` are revoked;
  2. a `BEFORE UPDATE OR DELETE` trigger and a `BEFORE TRUNCATE` trigger raise an exception for everyone, including the owner.

  A deliberate tamper has to disable the trigger as the owner. The tamper test does exactly that, and `/audit/verify` then detects it.
- `GET /audit/verify` recomputes the whole chain in id order (streamed in pages). It returns `{valid, count, firstBrokenId, reason, headHash}`. `reason` is one of `hash_mismatch`, `prev_hash_mismatch` or `id_gap`.

## Consequences

- One global chain means writes are serialised. That is fine for goal 01–03 volumes. If contention appears under goal 03 load (1,000 orders in a kill switch), we will move to per-partition chains anchored in a periodic global checkpoint (BACKLOG B-006).
- Hash anchoring outside the DB (for example daily head hash to WORM storage) is in goal 09 (BACKLOG B-007).
- IRTC R4-07 (2026-09-27): anchors are verified only against pinned public keys (the configured signing
  key plus `KORA_AUDIT_ANCHOR_TRUSTED_JWKS` for rotated keys), never the key stored in the anchor row.
  `/audit/verify` compares the chain with the latest trusted anchor and fails with
  `truncated_after_anchor` (events the anchor covers are missing) or `anchor_mismatch` (hash at the
  anchored id differs), and reports `eventsAfterLastAnchor`. The JSON-lines WORM copy is read back
  and checked (internal audit, KC-13). The anchoring job runs daily by default outside tests.
  Residual: events after the latest anchor are not yet witnessed; the daily cadence bounds that
  window, and real object-lock storage stays a deployment item.

## Known-answer vector (IRTC R6-01, 2026-09-27)

An auditor can re-implement the check against this vector. The event is
`{id: "1", ts: "2026-09-26T12:00:00.000000Z", actor_id: "u1", actor_type: "user", action: "test.event",
entity: "test", entity_id: "1", payload: {amount: "10.50"}}` with the genesis `prev_hash` (64 zeros).

- Canonical body: `{"action":"test.event","actor_id":"u1","actor_type":"user","entity":"test","entity_id":"1","id":"1","payload":{"amount":"10.50"},"ts":"2026-09-26T12:00:00.000000Z"}`
- `hash = sha256(body + prev_hash)` = `8cd10597fd12fc73dedf4f0c8aa8520826084f849302bc9b36771df6d007618a`

The vector is pinned in `packages/domain/src/audit.test.ts`, together with tests showing that changing
any hashed field (or `prev_hash`) changes the hash. `apps/api/test/audit.int.test.ts` tampers each
column in the database and expects `/audit/verify` to break at that row. Changing the hash specification
breaks the verification of every historical chain, so it needs a new ADR and a migration plan. Editing
the pinned vector is not enough.
