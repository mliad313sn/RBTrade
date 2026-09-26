import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { DEFAULT_ROBOT_LIMITS, type StrategyDefinition } from '@kora/domain';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/create-app';
import { bearer, createUser, ownerQuery, type TestUser } from './helpers';
import { MarketFixture } from './market-fixture';
import {
  RunnerEvents,
  seedCandles,
  startBotRunner,
  startQuant,
  TOKEN,
  wave,
  type Bar,
  type Spawned,
} from './robot-helpers';

const M = 60_000;
const T0 = Date.UTC(2025, 2, 3, 9, 0); // SIMULATED 1-minute bars (fixed, deterministic)
const TICK = 0.1;
const HALF_SPREAD = 0.5; // BTCUSD SIMULATED spread: 10 ticks
const HB = 300;

/**
 * Toy SMA cross, fixed size, exits on the reverse cross. The 4 % stop stays inside the crypto
 * fat-finger band (5 %, pre-trade risk refuses protective prices further away) and is never hit.
 */
const PARITY: StrategyDefinition = {
  schema: 'kora.strategy',
  schemaVersion: 1,
  name: 'Parity SMA',
  universe: { symbols: ['BTCUSD'], timeframe: '1m' },
  params: { fast: { value: 3, integer: true }, slow: { value: 8, integer: true } },
  entry: {
    side: 'long',
    conditions: [
      {
        type: 'cross',
        left: { kind: 'indicator', name: 'sma', period: { param: 'fast' } },
        direction: 'above',
        right: { kind: 'indicator', name: 'sma', period: { param: 'slow' } },
      },
    ],
  },
  filters: [],
  exit: {
    stop: { kind: 'percent', pct: 4 },
    conditions: [
      {
        type: 'cross',
        left: { kind: 'indicator', name: 'sma', period: { param: 'fast' } },
        direction: 'below',
        right: { kind: 'indicator', name: 'sma', period: { param: 'slow' } },
      },
    ],
  },
  size: { kind: 'fixed', qty: '0.5', maxOpenPositions: 1 },
};

/** Enters on the first bar and holds (for the drawdown and kill-switch drills). */
const ALWAYS_LONG: StrategyDefinition = {
  ...PARITY,
  name: 'Always long',
  params: {},
  entry: {
    side: 'long',
    conditions: [
      {
        type: 'compare',
        left: { kind: 'indicator', name: 'close' },
        op: 'gt',
        right: { kind: 'const', value: 1 },
      },
    ],
  },
  exit: { stop: { kind: 'percent', pct: 4 }, conditions: [] },
};

const bidAsk = (mid: number): [string, string] => [
  (mid - HALF_SPREAD).toFixed(1),
  (mid + HALF_SPREAD).toFixed(1),
];

describe('bot runner through the OMS (goal 06 acceptance)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let quant: Spawned;
  let runner: Spawned;
  let events: RunnerEvents;
  let redis: Redis;
  let owner: TestUser;
  const md = new MarketFixture();
  const prefix = process.env.KORA_MD_REDIS_PREFIX!;
  const bars: Bar[] = wave(70, T0, M, { base: 64000, amp: 120, period: 16, tick: TICK });

  const publishClosed = (symbol: string, b: Bar) =>
    redis.publish(
      `${prefix}candles:${symbol}:1m`,
      JSON.stringify({
        type: 'candle',
        symbol,
        tf: '1m',
        bucket: b.t,
        open: b.o.toFixed(1),
        high: b.h.toFixed(1),
        low: b.l.toFixed(1),
        close: b.c.toFixed(1),
        volume: '1',
        trades: 1,
        closed: true,
        source: 'simulated',
        seq: 1,
        exchangeTs: b.t + M,
        receivedTs: Date.now(),
      }),
    );

  async function createStrategy(u: TestUser, def: StrategyDefinition): Promise<string> {
    const s = await request(http)
      .post('/strategies')
      .set(bearer(u.token))
      .send({ definition: def })
      .expect(201);
    return s.body.latest.id as string;
  }

  async function createRobot(
    u: TestUser,
    versionId: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const r = await request(http)
      .post('/robots')
      .set(bearer(u.token))
      .send({ name: 'R', versionId, ...extra })
      .expect(201);
    return r.body.id as string;
  }

  async function startAndWaitForRunner(u: TestUser, robotId: string) {
    await request(http).post(`/robots/${robotId}/start`).set(bearer(u.token)).expect(200);
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      if (await redis.get(`kora:robots:hb:${robotId}`)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(
      `runner never picked up robot ${robotId}: ${runner.logs.join('').slice(-1500)}`,
    );
  }

  beforeAll(async () => {
    process.env.KORA_ENGINE_ENABLED = 'false';
    process.env.KORA_RECONCILIATION_INTERVAL_MS = '0';
    process.env.KORA_SERVICE_TOKEN = TOKEN;
    process.env.KORA_ROBOT_HEARTBEAT_MS = String(HB);
    process.env.KORA_ROBOT_SUPERVISOR_MS = '200';
    quant = await startQuant();
    process.env.QUANT_URL = quant.url;
    app = await createApp({ logger: false });
    app.useLogger(process.env.KORA_TEST_LOGS === '1' ? ['error', 'warn'] : false);
    await app.listen(0, '127.0.0.1');
    http = app.getHttpServer();
    const apiUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 2 });
    events = new RunnerEvents();
    await events.start();
    await seedCandles('BTCUSD', '1m', bars, 1);
    await md.status({ state: 'ok', feed: 'up', staleSymbols: [], ts: null });
    const [b0, a0] = bidAsk(bars[0]!.o);
    await md.quote('BTCUSD', b0, a0);
    runner = await startBotRunner({
      BOT_RUNNER_API_URL: apiUrl,
      QUANT_URL: quant.url,
      KORA_SERVICE_TOKEN: TOKEN,
      KORA_MD_REDIS_PREFIX: prefix,
      KORA_ROBOT_HEARTBEAT_MS: String(HB),
      KORA_BOT_RUNNER_SYNC_MS: '500',
    });
    owner = await createUser(app, 'trader', [], { realClock: true });
  }, 240_000);

  afterAll(async () => {
    events.close();
    redis.disconnect();
    await md.close();
    await runner?.stop();
    await app.close();
    await quant.stop();
    for (const k of [
      'KORA_ENGINE_ENABLED',
      'KORA_RECONCILIATION_INTERVAL_MS',
      'KORA_SERVICE_TOKEN',
      'KORA_ROBOT_HEARTBEAT_MS',
      'KORA_ROBOT_SUPERVISOR_MS',
      'QUANT_URL',
    ])
      delete process.env[k];
  });

  it('B-301: the internal API needs the service token; REST still refuses robot sources', async () => {
    await request(http).get('/internal/robots/running').expect(401);
    await request(http).get('/internal/robots/running').set(bearer(owner.token)).expect(401);
    await request(http)
      .get('/internal/robots/running')
      .set('x-kora-service-token', TOKEN)
      .expect(200);
    const rest = await request(http)
      .post('/orders')
      .set(bearer(owner.token))
      .send({
        clientOrderId: 'x-robot-spoof',
        symbol: 'BTCUSD',
        side: 'buy',
        type: 'market',
        qty: '0.1',
        source: 'robot:00000000-0000-0000-0000-000000000000',
      });
    expect(rest.status).toBe(400);
  });

  let parityRobot: string;
  let parityVersion: string;

  it('parity: paper-run fills for the same bars match the backtest trade list within the slippage-model tolerance', async () => {
    parityVersion = await createStrategy(owner, PARITY);
    parityRobot = await createRobot(owner, parityVersion);
    await startAndWaitForRunner(owner, parityRobot);
    const n = bars.length;
    for (let t = 0; t < n - 1; t++) {
      await md.status();
      const [bid, ask] = bidAsk(bars[t + 1]!.o);
      await md.quote('BTCUSD', bid, ask); // the market right after bar t closes = next bar's open
      await publishClosed('BTCUSD', bars[t]!);
      await events.wait(
        (e) => e.type === 'decision' && e.robotId === parityRobot && e.barTs === bars[t]!.t,
      );
    }
    const fills = await ownerQuery<{
      side: string;
      qty: string;
      price: string;
      ts: Date;
      role: string;
      client_order_id: string | null;
    }>(
      `SELECT f.side, f.qty, f.price, f.ts, o.role, o.client_order_id FROM fills f JOIN orders o ON o.id = f.order_id WHERE o.source = $1 ORDER BY f.ts, f.id`,
      [`robot:${parityRobot}`],
    );
    const bt = await request(http)
      .post('/backtests')
      .set(bearer(owner.token))
      .send({ versionId: parityVersion, from: T0, to: bars[n - 1]!.t + M, spreadTicks: 10 })
      .expect(201);
    const trades = bt.body.trades as Array<{
      entryTs: number;
      exitTs: number;
      entryPrice: string;
      exitPrice: string;
      qty: string;
      reason: string;
    }>;
    const closed = trades.filter((x) => x.reason !== 'end_of_data');
    expect(closed.length).toBeGreaterThanOrEqual(2);
    // Backtest legs in time order (entry, exit, entry, exit, …, plus an entry still open at the end).
    const legs: Array<{ ts: number; side: string; price: number }> = [];
    for (const x of trades) {
      legs.push({ ts: x.entryTs, side: 'buy', price: Number(x.entryPrice) });
      if (x.reason !== 'end_of_data')
        legs.push({ ts: x.exitTs, side: 'sell', price: Number(x.exitPrice) });
    }
    expect(fills.map((f) => f.side)).toEqual(legs.map((l) => l.side));
    const idx = new Map(bars.map((b, i) => [b.t, i]));
    for (let k = 0; k < legs.length; k++) {
      const leg = legs[k]!;
      const i = idx.get(leg.ts)!;
      // Slippage-model tolerance: the paper engine's volatility term uses the last quote-to-quote
      // mid move (|open(i) − open(i−1)|), the bar model uses the gap |open(i) − close(i−1)|.
      const vol = Math.ceil((0.1 * Math.abs(bars[i]!.o - bars[i - 1]!.o)) / TICK - 1e-9) * TICK;
      const tol = vol + TICK + 1e-9;
      expect(
        Math.abs(Number(fills[k]!.price) - leg.price),
        `leg ${k} at bar ${i}`,
      ).toBeLessThanOrEqual(tol);
      expect(fills[k]!.qty).toBe('0.5');
    }
    // Every decision is stored with its features and contributions, entries/exits are audited as the robot.
    const sig = await request(http)
      .get(`/robots/${parityRobot}/signals?limit=200`)
      .set(bearer(owner.token))
      .expect(200);
    const entry = sig.body.signals.find((s: { action: string }) => s.action === 'enter_long');
    expect(entry.outcome).toBe('submitted');
    expect(entry.conditions[0]).toMatchObject({
      type: 'cross',
      label: 'SMA 3 crosses above SMA 8',
      result: true,
    });
    expect(entry.features['sma:3']).toEqual(expect.any(Number));
    const features = await request(http)
      .get(`/signals/${entry.id}/features`)
      .set(bearer(owner.token))
      .expect(200);
    expect(features.body.conditions[0].contribution).toEqual(expect.any(Number));
    const audit = await ownerQuery<{ actor_type: string; actor_id: string }>(
      `SELECT actor_type, actor_id FROM audit_events WHERE action = 'order.new' AND payload->>'source' = $1`,
      [`robot:${parityRobot}`],
    );
    expect(audit.length).toBe(fills.length);
    expect(audit.every((a) => a.actor_type === 'robot' && a.actor_id === parityRobot)).toBe(true);
    await request(http)
      .post(`/robots/${parityRobot}/pause`)
      .set(bearer(owner.token))
      .send({ reason: 'parity done' })
      .expect(200);
  }, 120_000);

  it('auto-pauses on a max-drawdown breach in a simulated crash (and raises an alert)', async () => {
    const v = await createStrategy(owner, ALWAYS_LONG);
    const robot = await createRobot(owner, v, {
      allocation: '20000',
      limits: { ...DEFAULT_ROBOT_LIMITS, maxDrawdownPct: 5 },
    });
    await startAndWaitForRunner(owner, robot);
    const last = bars[bars.length - 1]!;
    const [bid, ask] = bidAsk(last.c);
    await md.status();
    await md.quote('BTCUSD', bid, ask);
    await publishClosed('BTCUSD', last);
    const d = await events.wait((e) => e.type === 'decision' && e.robotId === robot);
    expect(d).toMatchObject({ action: 'enter_long', outcome: 'submitted' });
    // Crash: −30 % in one print. The supervisor marks the robot to market and pauses it.
    const crash = last.c * 0.7;
    const t0 = Date.now();
    await md.status();
    await md.quote('BTCUSD', ...bidAsk(Math.round(crash * 10) / 10));
    let status = 'running';
    let reason: string | null = null;
    while (Date.now() - t0 < 5000) {
      const row = await ownerQuery<{ status: string; pause_reason: string | null }>(
        'SELECT status, pause_reason FROM robots WHERE id = $1',
        [robot],
      );
      status = row[0]!.status;
      reason = row[0]!.pause_reason;
      if (status === 'paused') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(status).toBe('paused');
    expect(reason).toBe('max_drawdown');
    expect(Date.now() - t0).toBeLessThan(2000);
    const alerts = await ownerQuery<{ severity: string; kind: string }>(
      `SELECT severity, kind FROM alerts WHERE details->>'robotId' = $1`,
      [robot],
    );
    expect(alerts).toEqual([{ severity: 'critical', kind: 'robot.max_drawdown' }]);
    const audit = await ownerQuery<{ actor_type: string; payload: { reason: string } }>(
      `SELECT actor_type, payload FROM audit_events WHERE action = 'robot.auto_paused' AND entity_id = $1`,
      [robot],
    );
    expect(audit[0]).toMatchObject({ actor_type: 'system', payload: { reason: 'max_drawdown' } });
    // Restore the market for the next drills.
    await md.quote('BTCUSD', bid, ask);
  }, 60_000);

  it('halts within 1 s of the global kill switch (runner reaction and robot state)', async () => {
    const u = await createUser(app, 'trader', [], { realClock: true });
    const v = await createStrategy(u, ALWAYS_LONG);
    const robot = await createRobot(u, v);
    await startAndWaitForRunner(u, robot);
    const t0 = Date.now();
    const res = await request(http)
      .post('/kill-switch')
      .set(bearer(u.token))
      .send({ scope: 'robots', source: 'ui_button', reason: 'drill' })
      .expect(202);
    expect(res.body.robotsHalted).toBe(true);
    const halted = await events.wait(
      (e) =>
        e.type === 'halted' &&
        Array.isArray(e.robotIds) &&
        (e.robotIds as string[]).includes(robot),
      2000,
    );
    expect(halted.receivedAt - t0).toBeLessThan(1000);
    let paused = false;
    while (Date.now() - t0 < 1000 && !paused) {
      paused =
        (
          await ownerQuery<{ status: string }>('SELECT status FROM robots WHERE id = $1', [robot])
        )[0]!.status === 'paused';
      if (!paused) await new Promise((r) => setTimeout(r, 20));
    }
    expect(paused).toBe(true);
    const row = await ownerQuery<{ pause_reason: string }>(
      'SELECT pause_reason FROM robots WHERE id = $1',
      [robot],
    );
    expect(row[0]!.pause_reason).toBe('kill_switch');
    // A bar closing after the halt is ignored by the runner.
    const before = events.events.filter((e) => e.robotId === robot && e.type === 'decision').length;
    await publishClosed('BTCUSD', bars[bars.length - 2]!);
    await new Promise((r) => setTimeout(r, 400));
    expect(events.events.filter((e) => e.robotId === robot && e.type === 'decision').length).toBe(
      before,
    );
    // Starting again is refused until trading resumes.
    const again = await request(http)
      .post(`/robots/${robot}/start`)
      .set(bearer(u.token))
      .expect(409);
    expect(again.body.error).toBe('trading_halted');
    await request(http)
      .post('/kill-switch/resume')
      .set(bearer(u.token))
      .send({ reason: 'drill over' })
      .expect(200);
    await request(http).post(`/robots/${robot}/start`).set(bearer(u.token)).expect(200);
    await request(http)
      .post(`/robots/${robot}/pause`)
      .set(bearer(u.token))
      .send({ reason: 'done' })
      .expect(200);
  }, 60_000);

  it('pauses a robot and alerts when the runner misses 3 heartbeats', async () => {
    const v = await createStrategy(owner, ALWAYS_LONG);
    const robot = await createRobot(owner, v);
    await startAndWaitForRunner(owner, robot);
    const t0 = Date.now();
    await runner.stop();
    let row = { status: 'running', pause_reason: null as string | null };
    while (Date.now() - t0 < 5000) {
      row = (
        await ownerQuery<{ status: string; pause_reason: string | null }>(
          'SELECT status, pause_reason FROM robots WHERE id = $1',
          [robot],
        )
      )[0]!;
      if (row.status === 'paused') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(row).toEqual({ status: 'paused', pause_reason: 'heartbeat_lost' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2 * HB);
    const alerts = await ownerQuery<{ severity: string; kind: string }>(
      `SELECT severity, kind FROM alerts WHERE details->>'robotId' = $1`,
      [robot],
    );
    expect(alerts).toEqual([{ severity: 'critical', kind: 'robot.heartbeat_lost' }]);
  }, 30_000);

  it('monitor view: limits usage, KPIs and the live audit feed', async () => {
    const d = await request(http)
      .get(`/robots/${parityRobot}`)
      .set(bearer(owner.token))
      .expect(200);
    expect(d.body).toMatchObject({ status: 'paused', environment: 'PAPER', mode: 'PAPER' });
    expect(Object.keys(d.body.limitsUsage)).toEqual([
      'dailyLoss',
      'weeklyLoss',
      'maxDrawdownPct',
      'ordersPerMinute',
      'grossExposure',
    ]);
    expect(d.body.kpis.outOfSample).not.toBeNull();
    const feed = await request(http)
      .get(`/robots/${parityRobot}/audit`)
      .set(bearer(owner.token))
      .expect(200);
    const actions = feed.body.events.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'robot.created',
        'robot.started',
        'robot.signal',
        'robot.paused',
        'strategy.version_created',
      ]),
    );
    const other = await createUser(app, 'trader', [], { realClock: true });
    await request(http).get(`/robots/${parityRobot}`).set(bearer(other.token)).expect(404);
    const list = await request(http).get('/robots').set(bearer(owner.token)).expect(200);
    expect(list.body.robots.length).toBeGreaterThanOrEqual(2);
  });
});
