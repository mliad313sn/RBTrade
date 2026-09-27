import pg from 'pg';

export const H = 3_600_000;

/**
 * SIMULATED BTC 1h history for the research window (fixed shape, ending two hours ago so it never
 * overlaps the live feed). BTCUSD trades 24/7, so the flow does not depend on the weekday.
 */
export async function seedHistory(): Promise<void> {
  const url = process.env.DATABASE_URL_MIGRATE_E2E;
  if (!url) throw new Error('DATABASE_URL_MIGRATE_E2E is not set');
  const end = Math.floor(Date.now() / H) * H - 2 * H;
  const n = 1400;
  const rows: Array<[number, string, string, string, string]> = [];
  let prev = 64000;
  for (let i = 0; i < n; i++) {
    const c =
      Math.round(
        (64000 + 2500 * Math.sin((2 * Math.PI * i) / 90) + 1.5 * i + ((i * 7919) % 13) * 0.1) * 10,
      ) / 10;
    const o = prev;
    rows.push([
      end - (n - i) * H,
      o.toFixed(1),
      (Math.max(o, c) + 0.3).toFixed(1),
      (Math.min(o, c) - 0.3).toFixed(1),
      c.toFixed(1),
    ]);
    prev = c;
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO md_candles_history (symbol, tf, bucket, open, high, low, close, volume, trades, source)
       SELECT 'BTCUSD', '1h', to_timestamp(b / 1000.0), o, h, l, c, 1, 1, 'e2e-simulated'
       FROM unnest($1::bigint[], $2::numeric[], $3::numeric[], $4::numeric[], $5::numeric[]) AS x(b, o, h, l, c)
       ON CONFLICT (symbol, tf, bucket) DO NOTHING`,
      [
        rows.map((r) => r[0]),
        rows.map((r) => r[1]),
        rows.map((r) => r[2]),
        rows.map((r) => r[3]),
        rows.map((r) => r[4]),
      ],
    );
  } finally {
    await client.end();
  }
}

