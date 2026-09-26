import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Client } from 'pg';

export const MIGRATIONS_DIR = resolve(__dirname, '../../migrations');

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Forward-only SQL migrations (ADR 0001). Each file runs in its own transaction and is recorded
 * with its SHA-256; editing an applied migration fails loudly.
 */
export async function runMigrations(connectionString: string, dir = MIGRATIONS_DIR): Promise<MigrationResult> {
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
  const client = new Client({ connectionString, application_name: 'kora-migrate' });
  await client.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('kora.migrations'))");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      name text NOT NULL,
      sha256 char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await client.query('REVOKE ALL ON schema_migrations FROM PUBLIC');
    const { rows } = await client.query<{ version: string; sha256: string }>(
      'SELECT version, sha256 FROM schema_migrations',
    );
    const applied = new Map(rows.map((r) => [r.version, r.sha256]));
    for (const file of files) {
      const sql = readFileSync(join(dir, file), 'utf8');
      const sha = createHash('sha256').update(sql).digest('hex');
      const version = file.slice(0, 4);
      const existing = applied.get(version);
      if (existing) {
        if (existing !== sha) throw new Error(`Migration ${file} was modified after being applied`);
        result.skipped.push(file);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, name, sha256) VALUES ($1, $2, $3)', [
          version,
          file,
          sha,
        ]);
        await client.query('COMMIT');
        result.applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('kora.migrations'))").catch(() => undefined);
    await client.end();
  }
  return result;
}
