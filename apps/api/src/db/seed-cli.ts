import '../env';

import type { Role } from '@kora/domain';
import { Pool } from 'pg';

import { hashPassword } from '../auth/password';

/**
 * Seeds SIMULATED demo users, one per role, with a password from KORA_SEED_PASSWORD.
 * Non-novice users must enrol TOTP at first login (MFA is never pre-seeded).
 */
async function main(): Promise<void> {
  const password = process.env.KORA_SEED_PASSWORD;
  if (!password || password.length < 12)
    throw new Error('Set KORA_SEED_PASSWORD (min 12 chars) to seed demo users');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const users: Array<[string, string, Role]> = [
    ['novice@kora.local', 'Simulated Novice', 'novice'],
    ['trader@kora.local', 'Simulated Trader', 'trader'],
    ['quant@kora.local', 'Simulated Quant', 'quant'],
    ['risk@kora.local', 'Simulated Risk Officer', 'risk_officer'],
    ['admin@kora.local', 'Simulated Admin', 'admin'],
  ];
  const hash = await hashPassword(password, Number(process.env.KORA_SCRYPT_N ?? 131072));
  for (const [email, name, role] of users) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, $3)
       ON CONFLICT ((lower(email))) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING id`,
      [email, name, hash],
    );
    const id = rows[0]!.id;
    await pool.query(
      'INSERT INTO user_roles (user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [id, role],
    );
    await pool.query(
      'INSERT INTO user_preferences (user_id, view_mode) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [id, role === 'novice' ? 'novice' : 'pro'],
    );
    console.warn(`[seed] ${email} (${role})`);
  }
  await pool.end();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
