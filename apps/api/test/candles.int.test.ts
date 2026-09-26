import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { appQuery, bearer, createUser, ownerQuery, startApp } from './helpers';

/**
 * Acceptance: GET /candles?symbol=EURUSD&tf=15m&limit=500 returns in < 150 ms p95 locally with
 * correct OHLCV aggregation (hand-computed bars through the SQL rollup).
 */

const DAY = '2026-01-05';
const at = (hms: string) => `${DAY}T${hms}Z`;
// [time, open, high, low, close, volume, trades]; the 10:15 open "1.0831" has fewer decimals than the registry precision.
const BARS: Array<[string, string, string, string, string, string, number]> = [
  ['10:00:00', '1.08400', '1.08410', '1.08395', '1.08405', '1000', 2],
  ['10:00:30', '1.08405', '1.08430', '1.08401', '1.08428', '3000', 3],
  ['10:00:59', '1.08428', '1.08429', '1.08380', '1.08390', '2000', 1],
  ['10:01:00', '1.08391', '1.08392', '1.08370', '1.08372', '500', 1],
  ['10:01:15', '1.08372', '1.08450', '1.08372', '1.08449', '4500', 4],
  ['10:04:59', '1.08449', '1.08449', '1.08440', '1.08441', '1000', 2],
  ['10:05:00', '1.08441', '1.08460', '1.08441', '1.08455', '700', 1],
  ['10:14:59', '1.08455', '1.08455', '1.08300', '1.08310', '800', 2],
  ['10:15:00', '1.0831', '1.08320', '1.08305', '1.08315', '100', 1],
];
const c = (hms: string, o: string, h: string, l: string, cl: string, v: string, n: number) => ({ t: Date.parse(at(hms)), open: o, high: h, low: l, close: cl, volume: v, trades: n });

const EXPECTED = {
  '1m': [
    c('10:00:00', '1.08400', '1.08430', '1.08380', '1.08390', '6000', 6),
    c('10:01:00', '1.08391', '1.08450', '1.08370', '1.08449', '5000', 5),
    c('10:04:00', '1.08449', '1.08449', '1.08440', '1.08441', '1000', 2),
    c('10:05:00', '1.08441', '1.08460', '1.08441', '1.08455', '700', 1),
    c('10:14:00', '1.08455', '1.08455', '1.08300', '1.08310', '800', 2),
    c('10:15:00', '1.08310', '1.08320', '1.08305', '1.08315', '100', 1),
  ],
  '5m': [
    c('10:00:00', '1.08400', '1.08450', '1.08370', '1.08441', '12000', 13),
    c('10:05:00', '1.08441', '1.08460', '1.08441', '1.08455', '700', 1),
    c('10:10:00', '1.08455', '1.08455', '1.08300', '1.08310', '800', 2),
    c('10:15:00', '1.08310', '1.08320', '1.08305', '1.08315', '100', 1),
  ],
  '15m': [c('10:00:00', '1.08400', '1.08460', '1.08300', '1.08310', '13500', 16), c('10:15:00', '1.08310', '1.08320', '1.08305', '1.08315', '100', 1)],
  '1h': [c('10:00:00', '1.08400', '1.08460', '1.08300', '1.08315', '13600', 17)],
  '4h': [c('08:00:00', '1.08400', '1.08460', '1.08300', '1.08315', '13600', 17)],
  '1D': [c('00:00:00', '1.08400', '1.08460', '1.08300', '1.08315', '13600', 17)],
} as const;

describe('GET /candles', () => {
  let app: INestApplication;
  let token: string;
  const range = `from=${DAY}T00:00:00Z&to=2026-01-06T00:00:00Z`;

  beforeAll(async () => {
    app = await startApp();
    token = (await createUser(app, 'novice')).token;
    await ownerQuery("DELETE FROM md_bars_1s WHERE symbol = 'EURUSD'; DELETE FROM md_candles WHERE symbol = 'EURUSD'; DELETE FROM md_candles_history WHERE symbol = 'EURUSD'");
    for (const [t, o, h, l, cl, v, n] of BARS) {
      await appQuery('INSERT INTO md_bars_1s (symbol, ts, open, high, low, close, volume, trades) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', ['EURUSD', at(t), o, h, l, cl, v, n]);
    }
    // Rollup as the runtime role, the way the feed runs it.
    await appQuery('SELECT md_refresh_candles($1)', [at('09:00:00')]);
  });
  afterAll(async () => app.close());

  it.each(Object.keys(EXPECTED) as Array<keyof typeof EXPECTED>)('%s aggregation equals the hand-computed bars', async (tf) => {
    const res = await request(app.getHttpServer()).get(`/candles?symbol=EURUSD&tf=${tf}&limit=500&${range}`).set(bearer(token)).expect(200);
    expect(res.body).toMatchObject({ symbol: 'EURUSD', tf, simulated: true, source: 'simulated' });
    expect(res.body.candles).toEqual(EXPECTED[tf]);
  });

  it('the rollup is idempotent and picks up late 1 s bars', async () => {
    await appQuery('SELECT md_refresh_candles($1)', [at('09:00:00')]);
    await appQuery("INSERT INTO md_bars_1s VALUES ('EURUSD', $1, '1.08315', '1.08999', '1.08315', '1.08320', '5', 1)", [at('10:15:30')]);
    await appQuery('SELECT md_refresh_candles($1)', [at('10:15:10')]);
    const res = await request(app.getHttpServer()).get(`/candles?symbol=EURUSD&tf=1D&${range}`).set(bearer(token)).expect(200);
    expect(res.body.candles).toEqual([c('00:00:00', '1.08400', '1.08999', '1.08300', '1.08320', '13605', 18)]);
    await appQuery("DELETE FROM md_bars_1s WHERE symbol = 'EURUSD' AND ts = $1", [at('10:15:30')]);
    await appQuery("DELETE FROM md_candles WHERE symbol = 'EURUSD'");
    await appQuery('SELECT md_refresh_candles($1)', [at('09:00:00')]);
  });

  it('merges SIMULATED history with live buckets (history open, live close, max/min, sums)', async () => {
    await appQuery(
      `INSERT INTO md_candles_history (symbol, tf, bucket, open, high, low, close, volume, trades, source) VALUES
       ('EURUSD', '15m', $1, '1.08300', '1.08360', '1.08290', '1.08350', '40', 4, 'simulated-history'),
       ('EURUSD', '15m', $2, '1.08350', '1.08500', '1.08360', '1.08399', '50', 3, 'simulated-history')`,
      [at('09:45:00'), at('10:00:00')],
    );
    const res = await request(app.getHttpServer()).get(`/candles?symbol=EURUSD&tf=15m&${range}`).set(bearer(token)).expect(200);
    expect(res.body.candles).toEqual([
      c('09:45:00', '1.08300', '1.08360', '1.08290', '1.08350', '40', 4),
      c('10:00:00', '1.08350', '1.08500', '1.08300', '1.08310', '13550', 19),
      c('10:15:00', '1.08310', '1.08320', '1.08305', '1.08315', '100', 1),
    ]);
    const limited = await request(app.getHttpServer()).get(`/candles?symbol=EURUSD&tf=15m&limit=2&${range}`).set(bearer(token)).expect(200);
    expect(limited.body.candles.map((x: { t: number }) => x.t)).toEqual([Date.parse(at('10:00:00')), Date.parse(at('10:15:00'))]);
  });

  it('serves 1 s bars and validates input', async () => {
    const http = app.getHttpServer();
    const s = await request(http).get(`/candles?symbol=EURUSD&tf=1s&limit=3&${range}`).set(bearer(token)).expect(200);
    expect(s.body.candles.map((x: { open: string }) => x.open)).toEqual(['1.08441', '1.08455', '1.08310']);
    await request(http).get('/candles?symbol=EURUSD&tf=2m').set(bearer(token)).expect(400);
    await request(http).get('/candles?symbol=EURUSD&tf=15m&limit=6000').set(bearer(token)).expect(400);
    await request(http).get('/candles?symbol=eurusd&tf=15m').set(bearer(token)).expect(400);
    await request(http).get('/candles?symbol=NOPE&tf=15m').set(bearer(token)).expect(404);
    await request(http).get('/candles?symbol=EURUSD&tf=15m').expect(401);
  });

  it('p95 < 150 ms for symbol=EURUSD&tf=15m&limit=500 over 5 000 history + 1 000 live candles', async () => {
    await ownerQuery(
      `INSERT INTO md_candles_history (symbol, tf, bucket, open, high, low, close, volume, trades, source)
       SELECT 'EURUSD', '15m', timestamptz '2025-11-01 00:00:00+00' + g * interval '15 minutes', 1.08400, 1.08450, 1.08350, 1.08420, 1000, 10, 'simulated-history'
       FROM generate_series(0, 4999) g ON CONFLICT DO NOTHING;
       INSERT INTO md_candles (symbol, tf, bucket, open, high, low, close, volume, trades)
       SELECT 'EURUSD', '15m', timestamptz '2025-12-20 00:00:00+00' + g * interval '15 minutes', 1.08410, 1.08460, 1.08360, 1.08430, 500, 5
       FROM generate_series(0, 999) g ON CONFLICT DO NOTHING;
       ANALYZE md_candles; ANALYZE md_candles_history;`,
    );
    const http = app.getHttpServer();
    const times: number[] = [];
    for (let i = 0; i < 220; i++) {
      const t0 = performance.now();
      const res = await request(http).get('/candles?symbol=EURUSD&tf=15m&limit=500').set(bearer(token));
      const dt = performance.now() - t0;
      expect(res.status).toBe(200);
      expect(res.body.candles).toHaveLength(500);
      if (i >= 20) times.push(dt); // first 20 are warm-up
    }
    times.sort((a, b) => a - b);
    const p = (q: number) => times[Math.min(times.length - 1, Math.ceil(q * times.length) - 1)]!;
    const summary = { n: times.length, p50: +p(0.5).toFixed(1), p95: +p(0.95).toFixed(1), p99: +p(0.99).toFixed(1), max: +times.at(-1)!.toFixed(1) };
    console.warn(`[candles latency ms] ${JSON.stringify(summary)}`);
    expect(summary.p95).toBeLessThan(150);
  });
});
