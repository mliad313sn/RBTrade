import '../env';

import { runMigrations } from './migrate';

async function main(): Promise<void> {
  const targets = process.argv.includes('--test')
    ? [process.env.DATABASE_URL_MIGRATE_TEST]
    : process.argv.includes('--all')
      ? [process.env.DATABASE_URL_MIGRATE, process.env.DATABASE_URL_MIGRATE_TEST]
      : [process.env.DATABASE_URL_MIGRATE];
  for (const url of targets) {
    if (!url) throw new Error('DATABASE_URL_MIGRATE (or _TEST) is not set');
    const r = await runMigrations(url);
    const db = new URL(url).pathname.slice(1);
    console.warn(`[migrate] ${db}: applied ${r.applied.length} (${r.applied.join(', ') || '-'}), up to date ${r.skipped.length}`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
