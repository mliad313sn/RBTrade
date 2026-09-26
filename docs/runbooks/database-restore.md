# Runbook — database restore

Category `database_restore`. SLO-10 (RPO ≤ 24 h), SLO-11 (RTO ≤ 4 h), SLO-12. Controls: KC-26
(backups taken and restores tested), KC-12/KC-13 (chain valid, anchors match), KC-14. Owner: SRE
on call (DBA role); the risk officer decides when trading may resume.

## Backups and restore tests

- `scripts/backup.sh [--db kora]`: `pg_dump` (custom format, `0600`, SHA-256 recorded) → restore into a
  scratch database `<db>_restore_test` → compares row counts of key tables and checks that the restored
  audit head exists in the source chain → writes both results to `backup_runs` (evidence for KC-26).
- Production: managed backups with point-in-time recovery and encrypted storage (deployment item,
  goal 10); the same restore test runs monthly against a scratch instance.
- Retention of backups follows the record-keeping schedule (placeholder, OQ-R4).

## When to restore

Data loss or corruption that cannot be repaired from the sources of truth (ledger, fills, audit log),
a failed migration that cannot roll forward, or a lost database host. A cache inconsistency is **not**
a restore case: use the [reconciliation runbook](reconciliation-break.md).

## Steps

1. **Log a P1 incident** and **halt trading firm-wide** (console, scope 2) so nothing writes while you work.
2. **Preserve evidence:** snapshot the damaged database (or keep the volume) before touching it; record
   the last good audit anchor (`/internal-audit/anchors`) and the head of the damaged chain.
3. **Choose the recovery point:** the latest backup (or PITR timestamp) before the damage. Everything
   after it will need replay or customer notification (PAPER: simulated balances only).
4. **Restore** into a new database: `createdb kora_restored && pg_restore --exit-on-error -d kora_restored <dump>`
   (PITR: follow the provider's procedure). Apply migrations if the dump is older than the release
   (`pnpm db:migrate`, forward-only and checksummed).
5. **Verify before switching:**
   - `GET /internal-audit/verify` against the restored database (point a scratch api at it): chain valid;
   - the restored head hash equals a signed anchor (or is a prefix of the last good chain);
   - `POST /reconciliation/run`: no mismatches;
   - row counts plausible against the backup record.
6. **Switch** the api to the restored database (config change under change control, release record
   KC-11), restart, confirm `/health`.
7. **Resume** trading through four-eyes (firm halt), then monitor SLO-1/2 for an hour.
8. **Resolve and review**: RPO/RTO achieved, data lost (if any), actions. Record the restore as a
   `backup_runs` row (`kind = restore_test` for tests; the incident references a real restore).

## Evidence

KC-26 CSV (backups and restore tests in the period), KC-12/KC-13, the incident (KC-25).
Latest restore test (2026-09-26, dev database): see the goal 09 plan §6.
