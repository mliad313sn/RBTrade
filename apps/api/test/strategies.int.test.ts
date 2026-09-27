import type { INestApplication } from '@nestjs/common';
import { RecordingProxy, validateExchanges } from './contract-proxy';
import { TREND_X, withParams, type StrategyDefinition } from '@kora/domain';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bearer, createUser, ownerQuery, startApp, type TestUser } from './helpers';
import { seedCandles, startQuant, wave, type Spawned } from './robot-helpers';

const H = 3_600_000;
const T0 = Date.UTC(2025, 0, 6); // SIMULATED research window (fixed, deterministic)

/** Trend-X logic on BTC 1h (24/7, so the test does not depend on the weekday). */
const BTC_TREND: StrategyDefinition = {
  ...TREND_X,
  name: 'Trend-X BTC',
  universe: { symbols: ['BTCUSD'], timeframe: '1h' },
  params: {
    ...TREND_X.params,
    fast: { ...TREND_X.params.fast!, value: 10 },
    slow: { ...TREND_X.params.slow!, value: 30 },
  },
  filters: [],
};

describe('strategies, versions and research runs (goal 06)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let quant: Spawned;
  let proxy: RecordingProxy;
  let trader: TestUser;
  let other: TestUser;
  let novice: TestUser;

  beforeAll(async () => {
    quant = await startQuant();
    proxy = await new RecordingProxy(quant.url, 'api').start();
    process.env.QUANT_URL = proxy.url;
    app = await startApp();
    http = app.getHttpServer();
    trader = await createUser(app, 'trader', [], { realClock: true });
    other = await createUser(app, 'trader', [], { realClock: true });
    novice = await createUser(app, 'novice', [], { realClock: true });
    await seedCandles(
      'BTCUSD',
      '1h',
      wave(1400, T0, H, { base: 64000, amp: 2500, period: 90, tick: 0.1, drift: 1.5 }),
      1,
    );
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await quant.stop();
    await proxy.stop();
    delete process.env.QUANT_URL;
  });

  it('novices cannot use the builder API (403) but can read the templates', async () => {
    for (const path of ['/strategies', '/backtests', '/robots', '/strategies/catalog'])
      await request(http).get(path).set(bearer(novice.token)).expect(403);
    const t = await request(http).get('/strategy-templates').set(bearer(novice.token)).expect(200);
    expect(t.body.templates.map((x: { id: string }) => x.id)).toEqual([
      'trend-x',
      'meanrev-gold',
      'breakout-crypto',
    ]);
    expect(t.body.templates[0].summary).toMatch(/price move/);
  });

  it('validates with plain-language issues, registry checks and a content hash', async () => {
    const ok = await request(http)
      .post('/strategies/validate')
      .set(bearer(trader.token))
      .send({ definition: BTC_TREND })
      .expect(200);
    expect(ok.body.valid).toBe(true);
    expect(ok.body.shortHash).toMatch(/^#[0-9a-f]{6}$/);
    expect(
      ok.body.issues.some(
        (i: { severity: string; message: string }) =>
          i.severity === 'warning' && /goal 07/.test(i.message),
      ),
    ).toBe(true);
    const bad = await request(http)
      .post('/strategies/validate')
      .set(bearer(trader.token))
      .send({ definition: { ...BTC_TREND, universe: { symbols: ['NOPE'], timeframe: '1h' } } })
      .expect(200);
    expect(bad.body.valid).toBe(false);
    expect(bad.body.issues.find((i: { severity: string }) => i.severity === 'error').message).toBe(
      'NOPE is not in the instrument registry.',
    );
    const schema = await request(http)
      .get('/strategies/schema')
      .set(bearer(trader.token))
      .expect(200);
    expect(schema.body.schema.required).toContain('entry');
  });

  let strategyId: string;
  let v1: { id: string; contentHash: string };
  let v2: { id: string; contentHash: string };

  it('creates immutable versions: same content → same version, param change → new hash, audited with author and reason', async () => {
    const c = await request(http)
      .post('/strategies')
      .set(bearer(trader.token))
      .send({ definition: BTC_TREND, reason: 'First cut' })
      .expect(201);
    strategyId = c.body.id;
    v1 = c.body.latest;
    expect(c.body.latest.version).toBe(1);
    const same = await request(http)
      .post(`/strategies/${strategyId}/versions`)
      .set(bearer(trader.token))
      .send({ definition: BTC_TREND, reason: 'No change', baseVersionId: v1.id })
      .expect(201);
    expect(same.body.created).toBe(false);
    expect(same.body.latest.id).toBe(v1.id);
    const edited = withParams(BTC_TREND, { stop_atr: 1.4 });
    const n = await request(http)
      .post(`/strategies/${strategyId}/versions`)
      .set(bearer(trader.token))
      .send({ definition: edited, reason: 'ATR stop 1.5 → 1.4', baseVersionId: v1.id })
      .expect(201);
    v2 = n.body.latest;
    expect(n.body.latest.version).toBe(2);
    expect(v2.contentHash).not.toBe(v1.contentHash);
    const stale = await request(http)
      .post(`/strategies/${strategyId}/versions`)
      .set(bearer(trader.token))
      .send({ definition: BTC_TREND, reason: 'Back', baseVersionId: v1.id })
      .expect(409);
    expect(stale.body.error).toBe('stale_version');
    const audit = await ownerQuery<{ actor_id: string; payload: Record<string, unknown> }>(
      `SELECT actor_id, payload FROM audit_events WHERE action = 'strategy.version_created' AND entity_id = $1 ORDER BY id`,
      [strategyId],
    );
    expect(audit).toHaveLength(2);
    expect(audit[1]!.actor_id).toBe(trader.id);
    expect(audit[1]!.payload).toMatchObject({
      version: 2,
      reason: 'ATR stop 1.5 → 1.4',
      previousHash: v1.contentHash,
      contentHash: v2.contentHash,
      paramsChanged: [{ name: 'stop_atr', from: '1.5', to: '1.4' }],
      logicChanged: false,
    });
    await expect(
      ownerQuery('UPDATE strategy_versions SET reason = $2 WHERE id = $1', [v1.id, 'tamper']),
    ).rejects.toThrow(/append-only/);
    // Other users cannot see or edit it.
    await request(http).get(`/strategies/${strategyId}`).set(bearer(other.token)).expect(404);
    await request(http)
      .post(`/strategies/${strategyId}/versions`)
      .set(bearer(other.token))
      .send({ definition: edited, reason: 'Hijack', baseVersionId: v2.id })
      .expect(404);
    const g = await request(http)
      .get(`/strategies/${strategyId}`)
      .set(bearer(trader.token))
      .expect(200);
    expect(g.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
  });

  let runId: string;

  it('backtests with the registry cost model, IS/OOS metrics, warnings and server-counted trials', async () => {
    const res = await request(http)
      .post('/backtests')
      .set(bearer(trader.token))
      .send({ versionId: v1.id })
      .expect(201);
    runId = res.body.runId;
    expect(res.body.simulated).toBe(true);
    expect(res.body.metrics.inSample.trades + res.body.metrics.outOfSample.trades).toBe(
      res.body.trades.length,
    );
    expect(res.body.trades.length).toBeGreaterThan(5);
    expect(res.body.costs.BTCUSD).toMatchObject({
      tickSize: 0.1,
      commissionBps: 10,
      spreadTicks: 10,
      volFactor: 0.1,
      fxToBase: 1,
      simulated: true,
    });
    expect(res.body.warnings.map((w: { code: string }) => w.code)).toContain('oos_trades_low');
    expect(res.body.guard.passed).toBe(true);
    expect(res.body.trialsTotal).toBe(1);
    const again = await request(http)
      .post('/backtests')
      .set(bearer(trader.token))
      .send({ versionId: v1.id })
      .expect(201);
    expect(again.body.trialsAdded).toBe(0);
    expect(again.body.overfitting.trials).toBe(1);
    const other2 = await request(http)
      .post('/backtests')
      .set(bearer(trader.token))
      .send({ versionId: v2.id })
      .expect(201);
    expect(other2.body.trialsTotal).toBe(2);
    expect(other2.body.overfitting.trials).toBe(2);
    const audit = await ownerQuery<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit_events WHERE action = 'backtest.run' AND payload->>'runId' = $1`,
      [runId],
    );
    expect(audit[0]!.payload).toMatchObject({
      strategyId,
      versionId: v1.id,
      trialsAdded: 1,
      simulated: true,
    });
    await request(http)
      .post('/backtests')
      .set(bearer(other.token))
      .send({ versionId: v1.id })
      .expect(404);
  });

  it('optimisation is capped and ranked by validation (holdout scored once); every combination is a trial', async () => {
    const big = await request(http)
      .post('/backtests/optimise')
      .set(bearer(trader.token))
      .send({
        versionId: v1.id,
        grid: { fast: [5, 10, 15, 20, 25, 30], slow: [30, 40, 50, 60, 70, 80, 90] },
        maxCombos: 20,
      })
      .expect(400);
    expect(big.body.message).toMatch(/42 parameter combinations requested; the limit is 20/);
    const opt = await request(http)
      .post('/backtests/optimise')
      .set(bearer(trader.token))
      .send({ versionId: v1.id, grid: { fast: [5, 10], slow: [30, 50] } })
      .expect(201);
    // IRTC R3-01: ranked on the validation segment; only the selected combination sees the holdout.
    expect(opt.body.rankedBy).toBe('validation_sharpe');
    expect(opt.body.evaluated).toBe(4);
    const val = opt.body.results
      .map((r: { validationSharpe: number | null }) => r.validationSharpe)
      .filter((x: number | null) => x !== null);
    expect(val).toEqual([...val].sort((a: number, b: number) => b - a));
    expect(opt.body.results.some((r: Record<string, unknown>) => 'oosSharpe' in r)).toBe(false);
    expect(opt.body.best.holdout).toHaveProperty('sharpe');
    expect(opt.body.validationStart).toBeLessThan(opt.body.oosStart);
    const s = await request(http)
      .get(`/strategies/${strategyId}`)
      .set(bearer(trader.token))
      .expect(200);
    expect(s.body.trials).toBeGreaterThanOrEqual(5);
  });

  it('sensitivity heatmap and walk-forward', async () => {
    const heat = await request(http)
      .post('/backtests/sensitivity')
      .set(bearer(trader.token))
      .send({
        versionId: v1.id,
        x: { param: 'fast', values: [5, 10, 15] },
        y: { param: 'stop_atr', values: [1, 1.5] },
      })
      .expect(201);
    expect(heat.body.cells).toHaveLength(2);
    expect(heat.body.cells[0]).toHaveLength(3);
    expect(heat.body.metric).toBe('validation_sharpe');
    expect(heat.body.x.current).toBe(10);
    const wf = await request(http)
      .post('/backtests/walk-forward')
      .set(bearer(trader.token))
      .send({ versionId: v1.id, mode: 'anchored', folds: 3 })
      .expect(201);
    expect(wf.body.folds).toHaveLength(3);
    expect(wf.body.metrics.trades).toBe(wf.body.trades.length);
    const list = await request(http)
      .get(`/backtests?strategyId=${strategyId}`)
      .set(bearer(trader.token))
      .expect(200);
    expect(list.body.runs.map((r: { kind: string }) => r.kind)).toEqual(
      expect.arrayContaining(['backtest', 'optimise', 'sensitivity', 'walk_forward']),
    );
  });

  it('sends the OOS trade list to Monte Carlo through /sim/from-trades (B-502)', async () => {
    const t = await request(http)
      .get(`/backtests/${runId}/trades?segment=oos`)
      .set(bearer(trader.token))
      .expect(200);
    expect(t.body.source).toBe('backtest_out_of_sample');
    expect(t.body.trades.length).toBeGreaterThanOrEqual(2);
    const mc = await request(http)
      .post('/sim/from-trades')
      .set(bearer(trader.token))
      .send({
        trades: t.body.trades,
        source: t.body.source,
        riskPct: 0.75,
        paths: 500,
        tradesPerPeriod: 10,
        horizonPeriods: 12,
      })
      .expect(200);
    expect(mc.body.kind).toBe('from_trades');
    expect(mc.body.realityChecks.map((c: { code: string }) => c.code)).toContain('small_sample');
    await request(http).get(`/backtests/${runId}`).set(bearer(other.token)).expect(404);
  });
  it('contract (goal 10): every api → quant exchange matches the quant OpenAPI', async () => {
    const doc = (await (await fetch(`${quant.url}/openapi.json`)).json()) as Parameters<typeof validateExchanges>[0];
    const traffic = proxy.exchanges.filter((x) => x.path !== '/health');
    expect(traffic.length).toBeGreaterThan(0);
    expect([...new Set(traffic.map((x) => x.path))]).toEqual(expect.arrayContaining(['/bt/optimise', '/bt/run', '/bt/sensitivity', '/bt/walk-forward']));
    expect(validateExchanges(doc, 'quant', traffic)).toEqual([]);
  });
});
