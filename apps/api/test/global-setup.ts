import '../src/env';

import { Client } from 'pg';

import { runMigrations } from '../src/db/migrate';

/** Fresh schema in the kora_test database, then all migrations. */
export default async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL_MIGRATE_TEST;
  if (!url)
    throw new Error('DATABASE_URL_MIGRATE_TEST is not set. Run scripts/dev-db.sh start first.');
  const c = new Client({ connectionString: url });
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
  await runMigrations(url);
}
