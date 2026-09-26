import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import pg from 'pg';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/** Fresh kora_e2e schema + migrations before the servers start. */
export default async function globalSetup(): Promise<void> {
  const url = process.env.DATABASE_URL_MIGRATE_E2E;
  if (!url) throw new Error('DATABASE_URL_MIGRATE_E2E is not set');
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query(`DO $$ DECLARE r record; BEGIN
    FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user LOOP
      EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', r.tablename);
    END LOOP;
    FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) = current_user LOOP
      EXECUTE format('DROP FUNCTION IF EXISTS %s CASCADE', r.sig);
    END LOOP;
  END $$;`);
  await c.end();
  execFileSync('pnpm', ['exec', 'tsx', 'src/db/migrate-cli.ts'], {
    cwd: resolve(__dirname, '../../api'),
    env: { ...process.env, DATABASE_URL_MIGRATE: url },
    stdio: 'inherit',
  });
}
