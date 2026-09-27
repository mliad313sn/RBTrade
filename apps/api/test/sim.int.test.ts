import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { paperFixtureFills, PAPER_FIXTURE_TRADES } from '../src/sim/paper-fixture';
import { quantBaseUrl } from '../src/sim/quant.client';
import { bearer, createUser, startApp, type TestUser } from './helpers';
import { MarketFixture } from './market-fixture';

interface Seen {
  path: string;
  body: Record<string, unknown>;
}

/** Stub of services/quant: records what the api sends and answers like the real service. */
let seen: Seen[] = [];
let mode: 'ok' | 'reject' | 'fail' = 'ok';
let stub: Server;

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c: Buffer) => (data += c.toString()));
    req.on('end', () => resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {}));
  });
}

const simResult = (kind: string, paths: number) => ({
  kind,
  simulated: true,
  inputHash: 'a'.repeat(64),
  cache: 'miss',
  paths,
  tradesPerPath: 480,
  realityChecks: [
    { code: 'small_sample', severity: 'warning', title: 'Small sample', message: '…' },
  ],
  bands: { p5: [1], p25: [1], p50: [1], p75: [1], p95: [1], mean: [1] },
});

describe('gain simulator proxy (/sim)', () => {
  let app: INestApplication;
  let trader: TestUser;
  let novice: TestUser;

  beforeAll(async () => {
    stub = createServer(async (req, res) => {
      const body = await readBody(req);
      const path = req.url ?? '';
      seen.push({ path, body });
      res.setHeader('content-type', 'application/json');
      if (mode === 'reject') {
        res.statusCode = 422;
        res.end(
          JSON.stringify({
            detail: [
              { loc: ['body', 'trades'], msg: 'Value error, trade 3 is odd', type: 'value_error' },
            ],
          }),
        );
        return;
      }
      if (mode === 'fail') {
        res.statusCode = 500;
        res.end('{}');
        return;
      }
      if (path.startsWith('/analytics/paper')) {
        const fills = body.fills as unknown[];
        res.end(
          JSON.stringify({
            trades: fills.length / 2,
            endingEquity: '10123.4',
            tradeReturnsPct: [1.5, -1, 0.8, -1],
          }),
        );
        return;
      }
      res.end(
        JSON.stringify(
          simResult(path === '/mc/project' ? 'project' : 'from_trades', Number(body.paths)),
        ),
      );
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
    process.env.QUANT_URL = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
    vi.useFakeTimers({ toFake: ['Date'] });
    app = await startApp();
    trader = await createUser(app, 'trader');
    novice = await createUser(app, 'novice');
  });

  afterAll(async () => {
    vi.useRealTimers();
    await app?.close();
    await new Promise<void>((r) => stub.close(() => r()));
    delete process.env.QUANT_URL;
    delete process.env.KORA_SIM_RATE_LIMIT;
  });

  beforeEach(() => {
    seen = [];
    mode = 'ok';
  });

  const http = () => app.getHttpServer();

  it('forwards a validated projection with defaults filled in and writes an audit event', async () => {
    const res = await request(http())
      .post('/sim/project')
      .set(bearer(trader.token))
      .send({ winRatePct: 45, avgWinR: 1.8, stressEdgeCutPct: 50 })
      .expect(200);
    expect(res.body.simulated).toBe(true);
    expect(res.body.auditEventId).toMatch(/^\d+$/);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe('/mc/project');
    expect(seen[0]!.body).toMatchObject({
      paths: 10_000,
      costPerTradeR: 0.08,
      sizingModel: 'fixed_fractional',
      stressEdgeCutPct: 50,
    });
    const audit = await request(http())
      .get('/audit?action=sim.projection_run')
      .set(bearer(trader.token))
      .expect(200);
    const ev = audit.body.events.find((e: { id: string }) => e.id === res.body.auditEventId);
    expect(ev).toBeTruthy();
    expect(ev.actorId).toBe(trader.id);
    expect(ev.payload).toMatchObject({
      kind: 'project',
      paths: 10_000,
      stressEdgeCutPct: '50',
      realityChecks: 'small_sample',
      environment: 'PAPER',
    });
  });

  it('novice accounts can run simulations too (nothing here touches orders)', async () => {
    await request(http())
      .post('/sim/project')
      .set(bearer(novice.token))
      .send({ paths: 1000 })
      .expect(200);
  });

  it.each([
    [{ winRatePct: 0 }, 'winRatePct', 'Win rate must be at least 1%'],
    [{ winRatePct: 100 }, 'winRatePct', 'Win rate must be at most 99%'],
    [{ riskPct: 40 }, 'riskPct', 'not a trading plan'],
    [{ paths: 60_000 }, 'paths', 'At most 50,000 paths'],
    [{ paths: 10 }, 'paths', 'at least 100 paths'],
    [{ tradesPerPeriod: 300, horizonPeriods: 20 }, 'horizonPeriods', 'the limit is 5000'],
    [
      { paths: 50_000, tradesPerPeriod: 100, horizonPeriods: 20 },
      'paths',
      'Reduce the number of paths',
    ],
    [{ winRatePct: '45' }, 'winRatePct', 'must be a number'],
    [{ surprise: true }, '', 'surprise'],
  ])('rejects %j with an explanation and never calls quant', async (body, path, fragment) => {
    const res = await request(http())
      .post('/sim/project')
      .set(bearer(trader.token))
      .send(body)
      .expect(400);
    expect(res.body.error).toBe('validation_failed');
    const issue = res.body.issues.find((i: { path: string; message: string }) => i.path === path);
    expect(issue?.message ?? JSON.stringify(res.body.issues)).toContain(fragment);
    expect(seen).toHaveLength(0);
  });

  it('bootstraps an imported trade list and audits its source', async () => {
    const res = await request(http())
      .post('/sim/from-trades')
      .set(bearer(trader.token))
      .send({ trades: [1.8, -1, -1, 2.1], source: 'backtest_in_sample', paths: 500 })
      .expect(200);
    expect(seen[0]!.body).toMatchObject({
      tradeUnit: 'r_multiple',
      blockSize: null,
      source: 'backtest_in_sample',
    });
    const audit = await request(http())
      .get('/audit?action=sim.bootstrap_run')
      .set(bearer(trader.token))
      .expect(200);
    const ev = audit.body.events.find((e: { id: string }) => e.id === res.body.auditEventId);
    expect(ev.payload).toMatchObject({ source: 'backtest_in_sample', importedTrades: 4 });
    await request(http())
      .post('/sim/from-trades')
      .set(bearer(trader.token))
      .send({ trades: [1, -1], blockSize: 3 })
      .expect(400);
    // IRTC R3-07: a cost in R cannot apply to % returns: refused, never silently ignored.
    const pct = await request(http())
      .post('/sim/from-trades')
      .set(bearer(trader.token))
      .send({ trades: [1.5, -0.8, 0.4], tradeUnit: 'pct_return', extraCostPerTradeR: 2 })
      .expect(400);
    expect(JSON.stringify(pct.body.issues)).toContain('cannot be applied to % returns');
  });

  it('paper analytics and "project from my paper results" use the labelled SIMULATED fixture for an account with no fills', async () => {
    const a = await request(http())
      .get('/sim/paper/analytics')
      .set(bearer(trader.token))
      .expect(200);
    expect(a.body.source).toMatchObject({ kind: 'fixture', simulated: true, label: expect.stringContaining('no paper fills on this account yet') });
    expect(seen[0]!.path).toBe('/analytics/paper?simulated_source=true');
    expect((seen[0]!.body.fills as unknown[]).length).toBe(2 * PAPER_FIXTURE_TRADES);

    seen = [];
    const p = await request(http())
      .post('/sim/paper/project')
      .set(bearer(trader.token))
      .send({ horizonPeriods: 12, paths: 2000 })
      .expect(200);
    expect(seen.map((s) => s.path)).toEqual([
      '/analytics/paper?simulated_source=true',
      '/mc/from-trades',
    ]);
    expect(seen[1]!.body).toMatchObject({
      trades: [1.5, -1, 0.8, -1],
      tradeUnit: 'pct_return',
      source: 'paper',
      startingCapital: 10123.4,
      horizonPeriods: 12,
    });
    expect(p.body.projection.auditEventId).toMatch(/^\d+$/);
    expect(p.body.analytics.trades).toBe(PAPER_FIXTURE_TRADES);
    const audit = await request(http())
      .get('/audit?action=sim.paper_projection_run')
      .set(bearer(trader.token))
      .expect(200);
    expect(
      audit.body.events.some((e: { id: string }) => e.id === p.body.projection.auditEventId),
    ).toBe(true);
  });

  it('B-501: an account with paper fills sends its real fills, fees in base currency and registry multipliers', async () => {
    const md = new MarketFixture();
    await md.standard();
    const u = await createUser(app, 'trader');
    await md.touch();
    const buy = await request(http()).post('/orders').set(bearer(u.token)).send({ clientOrderId: `b501-${process.pid}`, symbol: 'BTCUSD', side: 'buy', type: 'market', qty: '0.5' }).expect(201);
    await md.quote('BTCUSD', '65811.5', '65813.5');
    await request(http()).post('/positions/BTCUSD/close').set(bearer(u.token)).expect(201);
    seen = [];
    const a = await request(http()).get('/sim/paper/analytics').set(bearer(u.token)).expect(200);
    expect(a.body.source).toMatchObject({ kind: 'paper_account', simulated: true, fills: 2, currency: 'USD' });
    expect(seen[0]!.path).toBe('/analytics/paper');
    const sent = seen[0]!.body as { startingCapital: string; fills: Array<Record<string, string>>; contractMultipliers: Record<string, string> };
    expect(sent.startingCapital).toBe('100000');
    expect(sent.contractMultipliers).toEqual({ BTCUSD: '1' });
    expect(sent.fills).toHaveLength(2);
    expect(sent.fills[0]).toMatchObject({ orderId: buy.body.order.id, symbol: 'BTCUSD', side: 'buy', qty: '0.5', price: '64813.5', fee: '32.41', slippage: '0' });
    expect(sent.fills[1]).toMatchObject({ side: 'sell', qty: '0.5' });
    for (const f of sent.fills) expect(f.ts).toMatch(/Z$/);
    seen = [];
    const p = await request(http()).post('/sim/paper/project').set(bearer(u.token)).send({ horizonPeriods: 12, paths: 2000 }).expect(200);
    expect(p.body.source.kind).toBe('paper_account');
    const audit = await request(http()).get('/audit?action=sim.paper_projection_run').set(bearer(u.token)).expect(200);
    expect(audit.body.events[0].payload).toMatchObject({ source: 'paper_account' });
    await md.close();
  });

  it('maps quant validation errors to 400 with issues, and quant failures to 502/503', async () => {
    mode = 'reject';
    const r = await request(http())
      .post('/sim/from-trades')
      .set(bearer(trader.token))
      .send({ trades: [1, -1] })
      .expect(400);
    expect(r.body.issues).toEqual([
      { path: 'trades', message: 'trade 3 is odd', code: 'value_error' },
    ]);
    mode = 'fail';
    const f = await request(http())
      .post('/sim/project')
      .set(bearer(trader.token))
      .send({})
      .expect(502);
    expect(f.body.error).toBe('quant_error');
    const saved = process.env.QUANT_URL;
    process.env.QUANT_URL = 'http://127.0.0.1:1';
    try {
      const u = await request(http())
        .post('/sim/project')
        .set(bearer(trader.token))
        .send({})
        .expect(503);
      expect(u.body).toMatchObject({ error: 'quant_unavailable' });
      expect(u.body.message).toContain('Nothing was simulated');
    } finally {
      process.env.QUANT_URL = saved;
    }
  });

  it('requires a session', async () => {
    await request(http()).post('/sim/project').set('x-kora-csrf', '1').send({}).expect(401);
  });

  it('rate-limits simulation runs per client (429)', async () => {
    process.env.KORA_SIM_RATE_LIMIT = '3';
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      codes.push(
        (
          await request(http())
            .post('/sim/project')
            .set(bearer(trader.token))
            .send({ paths: 100, seed: 1000 + i })
        ).status,
      );
    }
    delete process.env.KORA_SIM_RATE_LIMIT;
    expect(codes).toContain(429);
  });
});

describe('sim helpers', () => {
  it('quantBaseUrl prefers QUANT_URL, then QUANT_PORT', () => {
    expect(quantBaseUrl({ QUANT_URL: 'http://q:9/' })).toBe('http://q:9');
    expect(quantBaseUrl({ QUANT_PORT: '8123' })).toBe('http://127.0.0.1:8123');
    expect(quantBaseUrl({})).toBe('http://127.0.0.1:8000');
  });

  it('the paper fixture is deterministic, balanced and uses decimal strings', () => {
    const a = paperFixtureFills();
    expect(paperFixtureFills()).toEqual(a);
    expect(a).toHaveLength(2 * PAPER_FIXTURE_TRADES);
    for (const f of a) {
      expect(f.price).toMatch(/^\d+\.\d{5}$/);
      expect(typeof f.qty).toBe('string');
    }
    expect(a[0]!.id).toBe('sim-f1');
    expect(Date.parse(a[a.length - 1]!.ts)).toBeGreaterThan(Date.parse(a[0]!.ts));
  });
});
