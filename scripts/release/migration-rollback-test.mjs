#!/usr/bin/env node
/**
 * Migration rollback drill (goal 10, S10/S3). KORA migrations are forward-only and checksummed
 * (ADR 0001), so a bad release is rolled back by restoring the pre-migration backup, never by
 * down-migrations. This drill proves that procedure end to end on a scratch copy of a database:
 *
 *   1. copy the source database (default kora_e2e, which holds the load-test data) into a scratch
 *      database and take the pre-release backup (pg_dump, custom format);
 *   2. "bad release": run the real migrations plus a probe migration that changes the schema, and
 *      write data into the new objects; also run a migration that fails half way and check that it
 *      left nothing behind (each migration is one transaction);
 *   3. roll back: recreate the database from the pre-release backup (pg_restore --exit-on-error);
 *   4. verify: schema fingerprint and schema_migrations equal the pre-release state, the probe
 *      objects are gone, the audit chain verifies from genesis and its head is unchanged, row counts
 *      of the key tables match;
 *   5. roll forward again with the real migrations: nothing to apply (still up to date).
 *
 * Usage (repo root, dev DB running, packages built): node scripts/release/migration-rollback-test.mjs [--db kora_e2e]
 * Output: docs/qa/release/migration-rollback.json. Never runs against production data.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const req = createRequire(join(ROOT, 'apps/api/package.json'));
const pg = req('pg');
process.loadEnvFile(join(ROOT, '.env'));
const { AuditChainVerifier } = await import(
  pathToFileURL(join(ROOT, 'packages/domain/dist/server.js')).href
);
const { runMigrations } = req(join(ROOT, 'apps/api/dist/db/migrate.js'));

const args = process.argv.slice(2);
const SRC = args.includes('--db') ? args[args.indexOf('--db') + 1] : 'kora_e2e';
const SCRATCH = 'kora_rollback_test';
const PORT = process.env.KORA_PG_PORT ?? '55432';
const admin =
  process.env.KORA_BACKUP_ADMIN_URL ??
  `postgres://postgres:${process.env.KORA_PG_SUPERUSER_PASSWORD ?? ''}@127.0.0.1:${PORT}/postgres`;
const withDb = (url, db) => url.replace(/\/[^/?]+(\?|$)/, `/${db}$1`);
const ownerUrl = withDb(process.env.DATABASE_URL_MIGRATE, SCRATCH);
const work = mkdtempSync(join(tmpdir(), 'kora-rollback-'));
const steps = [];
const step = (name, ok, detail = {}) => {
  steps.push({ name, ok, ...detail });
  console.warn(`[rollback] ${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) throw new Error(`${name} failed: ${JSON.stringify(detail)}`);
};
async function q(url, sql, params = []) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
}
const sh = (cmd, a) =>
  execFileSync(cmd, a, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
async function recreate() {
  await q(admin, `DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
  await q(admin, `CREATE DATABASE ${SCRATCH} OWNER kora_owner`);
}
function schemaFingerprint() {
  const ddl = sh('pg_dump', ['--schema-only', '--no-comments', withDb(admin, SCRATCH)]).toString();
  const norm = ddl
    .split('\n')
    .filter(
      (l) => !l.startsWith('--') && !/^\\(un)?restrict /.test(l) && !/^SET /.test(l) && l.trim(),
    )
    .join('\n');
  return createHash('sha256').update(norm).digest('hex');
}
async function state() {
  const migrations = (
    await q(ownerUrl, 'SELECT version, sha256 FROM schema_migrations ORDER BY version')
  ).map((r) => `${r.version}:${r.sha256.slice(0, 12)}`);
  const counts = {};
  for (const t of [
    'users',
    'accounts',
    'orders',
    'fills',
    'positions',
    'ledger_entries',
    'audit_events',
    'robots',
  ])
    counts[t] = (await q(ownerUrl, `SELECT count(*)::int AS n FROM ${t}`))[0].n;
  const head =
    (
      await q(
        ownerUrl,
        'SELECT id::text AS id, hash FROM audit_events ORDER BY audit_events.id DESC LIMIT 1',
      )
    )[0] ?? null;
  return { schema: schemaFingerprint(), migrations, counts, head };
}
async function verifyChain() {
  const v = new AuditChainVerifier();
  let after = '0';
  for (;;) {
    const rows = await q(
      ownerUrl,
      `SELECT id::text AS id, to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts, actor_id, actor_type, action, entity, entity_id, payload, prev_hash, hash
         FROM audit_events WHERE audit_events.id > $1::bigint ORDER BY audit_events.id LIMIT 5000`,
      [after],
    );
    if (!rows.length) break;
    for (const r of rows)
      v.push({
        id: r.id,
        ts: r.ts,
        actorId: r.actor_id,
        actorType: r.actor_type,
        action: r.action,
        entity: r.entity,
        entityId: r.entity_id,
        payload: r.payload,
        prevHash: r.prev_hash,
        hash: r.hash,
      });
    after = rows[rows.length - 1].id;
  }
  return v.result();
}

const out = { startedAt: new Date().toISOString(), source: SRC, scratch: SCRATCH, steps };
try {
  // 1. scratch copy + pre-release backup
  const srcDump = join(work, 'source.dump');
  sh('pg_dump', ['--format=custom', `--file=${srcDump}`, withDb(admin, SRC)]);
  await recreate();
  sh('pg_restore', ['--exit-on-error', `--dbname=${withDb(admin, SCRATCH)}`, srcDump]);
  await runMigrations(ownerUrl); // bring the copy to the current release first
  const pre = await state();
  const preDump = join(work, 'pre-release.dump');
  sh('pg_dump', ['--format=custom', `--file=${preDump}`, withDb(admin, SCRATCH)]);
  step('pre-release backup taken', true, {
    auditEvents: pre.counts.audit_events,
    orders: pre.counts.orders,
    migrations: pre.migrations.length,
  });

  // 2a. a migration that fails half way leaves nothing behind
  const failing = join(work, 'failing');
  mkdirSync(failing);
  for (const f of readdirSync(join(ROOT, 'apps/api/migrations')))
    copyFileSync(join(ROOT, 'apps/api/migrations', f), join(failing, f));
  writeFileSync(
    join(failing, '9991_rollback_probe_fails.sql'),
    'CREATE TABLE rollback_probe_fail (id int);\nALTER TABLE orders ADD COLUMN rollback_probe_fail int;\nSELECT 1 / 0;\n',
  );
  let failedCleanly = false;
  try {
    await runMigrations(ownerUrl, failing);
  } catch (e) {
    failedCleanly = /9991_rollback_probe_fails\.sql failed/.test(e.message);
  }
  const leftovers = await q(
    ownerUrl,
    `SELECT (to_regclass('rollback_probe_fail') IS NOT NULL) AS t, EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'rollback_probe_fail') AS c, EXISTS (SELECT 1 FROM schema_migrations WHERE version = '9991') AS m`,
  );
  step(
    'failed migration is atomic (no table, no column, not recorded)',
    failedCleanly && !leftovers[0].t && !leftovers[0].c && !leftovers[0].m,
    leftovers[0],
  );

  // 2b. the bad release applies and writes data
  const bad = join(work, 'bad');
  mkdirSync(bad);
  for (const f of readdirSync(join(ROOT, 'apps/api/migrations')))
    copyFileSync(join(ROOT, 'apps/api/migrations', f), join(bad, f));
  writeFileSync(
    join(bad, '9990_rollback_probe.sql'),
    'CREATE TABLE rollback_probe (id serial PRIMARY KEY, note text NOT NULL);\nALTER TABLE orders ADD COLUMN rollback_probe text;\nGRANT SELECT, INSERT ON rollback_probe TO kora_app;\n',
  );
  const applied = await runMigrations(ownerUrl, bad);
  await q(ownerUrl, "INSERT INTO rollback_probe (note) VALUES ('written by the bad release')");
  await q(
    ownerUrl,
    "UPDATE orders SET rollback_probe = 'x' WHERE id IN (SELECT id FROM orders LIMIT 10)",
  );
  const during = await state();
  step(
    'bad release applied (schema changed)',
    applied.applied.includes('9990_rollback_probe.sql') && during.schema !== pre.schema,
    { applied: applied.applied },
  );

  // 3. roll back = restore the pre-release backup
  const t0 = Date.now();
  await recreate();
  sh('pg_restore', ['--exit-on-error', `--dbname=${withDb(admin, SCRATCH)}`, preDump]);
  const restoreMs = Date.now() - t0;
  const post = await state();

  // 4. verify
  step('schema identical to pre-release', post.schema === pre.schema, {
    pre: pre.schema.slice(0, 16),
    post: post.schema.slice(0, 16),
  });
  step(
    'schema_migrations identical (probe not recorded)',
    JSON.stringify(post.migrations) === JSON.stringify(pre.migrations) &&
      !post.migrations.some((m) => m.startsWith('9990')),
  );
  const gone = await q(
    ownerUrl,
    `SELECT (to_regclass('rollback_probe') IS NULL) AS t, NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'rollback_probe') AS c`,
  );
  step('probe objects removed', gone[0].t && gone[0].c);
  step('row counts identical', JSON.stringify(post.counts) === JSON.stringify(pre.counts), {
    counts: post.counts,
  });
  const chain = await verifyChain();
  step(
    'audit chain verifies from genesis, head unchanged',
    chain.valid && post.head?.hash === pre.head?.hash,
    { chain, head: post.head },
  );

  // 5. roll forward with the real release
  const again = await runMigrations(ownerUrl);
  step('roll forward: already up to date', again.applied.length === 0, {
    skipped: again.skipped.length,
  });
  out.restoreMs = restoreMs;
  out.ok = true;
} catch (e) {
  out.ok = false;
  out.error = e.message;
} finally {
  await q(admin, `DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`).catch(() => undefined);
  rmSync(work, { recursive: true, force: true });
  out.finishedAt = new Date().toISOString();
  mkdirSync(join(ROOT, 'docs/qa/release'), { recursive: true });
  writeFileSync(
    join(ROOT, 'docs/qa/release/migration-rollback.json'),
    `${JSON.stringify(out, null, 2)}\n`,
  );
  console.warn(`[rollback] ${out.ok ? 'PASS' : 'FAIL'} → docs/qa/release/migration-rollback.json`);
  process.exitCode = out.ok ? 0 : 1;
}
