import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountsService } from '../src/trading/accounts.service';
import { EngineLoopService } from '../src/trading/engine-loop.service';
import { KillSwitchService } from '../src/trading/kill-switch.service';
import { dayExpiry, OmsService } from '../src/trading/oms.service';
import { TradingRegistryService } from '../src/trading/trading-registry.service';
import {
  acknowledgeRiskWarning,
  bearer,
  createUser,
  login,
  ownerQuery,
  startApp,
  type TestUser,
} from './helpers';
import { MARKET_OPEN_UTC, MarketFixture, marketDay } from './market-fixture';

let n = 0;
const cid = () => `irtc-r2-${process.pid}-${++n}`;

interface Fill {
  qty: string;
  price: string;
  commission: string;
  fxConversionCost: string;
  liquidity: string;
  side: string;
}

/**
 * IRTC seat R2 regression tests (docs/review/IRTC-R2-fixes.md). Each test reproduces one confirmed
 * trading/money finding through the real API and fails on the code as reviewed.
 */
describe('IRTC R2 regressions (trading and money correctness)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let engine: EngineLoopService;
  const md = new MarketFixture();

  beforeAll(async () => {
    process.env.KORA_ENGINE_ENABLED = 'false';
    process.env.KORA_RECONCILIATION_INTERVAL_MS = '0';
    process.env.KORA_MARGIN_CHECK_MS = '0';
    process.env.KORA_API_RATE_LIMIT = '100000';
    process.env.KORA_ORDER_RATE_LIMIT = '100000';
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(MARKET_OPEN_UTC);
    app = await startApp();
    http = app.getHttpServer();
    engine = app.get(EngineLoopService);
  });
  let minute = 0;
  beforeEach(async () => {
    // One fresh minute per test (still Wednesday afternoon, all markets open): per-minute throttles
    // such as the appropriateness attempt limit do not carry over between tests.
    vi.setSystemTime(MARKET_OPEN_UTC.getTime() + minute++ * 61_000);
    await md.standard();
    await md.clearDepth('EURUSD');
    await md.clearDepth('AAPL');
  });
  afterAll(async () => {
    await md.close();
    await app.close();
    vi.useRealTimers();
    delete process.env.KORA_ENGINE_ENABLED;
    delete process.env.KORA_RECONCILIATION_INTERVAL_MS;
    delete process.env.KORA_MARGIN_CHECK_MS;
    delete process.env.KORA_API_RATE_LIMIT;
    delete process.env.KORA_ORDER_RATE_LIMIT;
  });

  const place = async (u: TestUser, body: object) => {
    await md.touch();
    return request(http)
      .post('/orders')
      .set(bearer(u.token))
      .send({ clientOrderId: cid(), ...body });
  };
  const preview = async (u: TestUser, body: object) => {
    await md.touch();
    return request(http).post('/orders/preview').set(bearer(u.token)).send(body);
  };
  const get = (u: TestUser, path: string) => request(http).get(path).set(bearer(u.token));
  const patch = async (u: TestUser, path: string, body: object) => {
    await md.touch();
    return request(http).patch(path).set(bearer(u.token)).send(body);
  };
  const del = (u: TestUser, path: string) => request(http).delete(path).set(bearer(u.token));
  const fills = async (u: TestUser, symbol?: string): Promise<Fill[]> =>
    (await get(u, `/fills${symbol ? `?symbol=${symbol}` : ''}`)).body.fills as Fill[];
  const position = async (u: TestUser, symbol: string): Promise<string> =>
    ((await get(u, '/positions')).body.positions as Array<{ symbol: string; qty: string }>).find(
      (p) => p.symbol === symbol,
    )?.qty ?? '0';
  const relogin = async (u: TestUser) => {
    u.token = (await login(app, u.email, u.secret)).token;
  };

  // ---- R2-01 / R2-21 / R2-03: risk on amend, at resting fills, and across working orders ----------

  it('R2-01: amending a working order re-runs pre-trade risk (qty increase past every limit is refused)', async () => {
    const u = await createUser(app, 'trader');
    const small = await place(u, {
      symbol: 'EURUSD',
      side: 'buy',
      type: 'limit',
      qty: '10000',
      limitPrice: '1.08000',
    });
    expect(small.status).toBe(201);
    const am = await patch(u, `/orders/${small.body.order.id}`, { qty: '50000000' });
    expect(am.status, JSON.stringify(am.body)).toBe(422);
    const codes = (am.body.violations as Array<{ code: string }>).map((v) => v.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'MAX_ORDER_NOTIONAL',
        'MAX_POSITION',
        'MAX_LEVERAGE',
        'INSUFFICIENT_MARGIN',
      ]),
    );
    const o = (await get(u, `/orders/${small.body.order.id}`)).body;
    expect(o.qty).toBe('10000');
    // A harmless amend still works, and the market reaching the limit fills only the approved size.
    expect((await patch(u, `/orders/${small.body.order.id}`, { qty: '20000' })).status).toBe(200);
    await md.quote('EURUSD', '1.07998', '1.08000');
    await engine.matchSymbol('EURUSD');
    expect(await position(u, 'EURUSD')).toBe('20000');
  });

  it('R2-21: a resting order is re-checked before it fills (daily loss limit hit after acceptance)', async () => {
    const u = await createUser(app, 'trader');
    {
      const r0 = await place(u, { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '900000' });
      expect(r0.status, JSON.stringify(r0.body)).toBe(201);
    }
    const rest = await place(u, {
      symbol: 'EURUSD',
      side: 'buy',
      type: 'limit',
      qty: '100000',
      limitPrice: '1.07500',
    });
    expect(rest.status).toBe(201);
    expect(rest.body.order.status).toBe('working');
    // The market falls: about -8,300 USD on the long, past the 5,000 USD daily loss limit.
    await md.quote('EURUSD', '1.07498', '1.07500');
    await engine.matchSymbol('EURUSD');
    const o = (await get(u, `/orders/${rest.body.order.id}`)).body;
    expect(o.status).toBe('cancelled');
    expect(o.cancelReason).toMatch(/^risk_recheck/);
    expect(await position(u, 'EURUSD')).toBe('900000');
    const audit = await ownerQuery<{ payload: { codes: string } }>(
      `SELECT payload FROM audit_events WHERE action = 'order.risk_recheck_failed' AND entity_id = $1`,
      [rest.body.order.id],
    );
    expect(audit[0]?.payload.codes).toContain('DAILY_LOSS_LIMIT');
  });

  it('R2-03: several "reducing" orders cannot together flip the position past the limits', async () => {
    const u = await createUser(app, 'trader');
    {
      const r0 = await place(u, { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '900000' });
      expect(r0.status, JSON.stringify(r0.body)).toBe(201);
    }
    const statuses: number[] = [];
    const rejectCodes: string[] = [];
    for (let i = 0; i < 5; i++) {
      const s = await place(u, {
        symbol: 'EURUSD',
        side: 'sell',
        type: 'limit',
        qty: '900000',
        limitPrice: '1.08900',
      });
      statuses.push(s.status);
      if (s.status === 422)
        rejectCodes.push(...(s.body.violations as Array<{ code: string }>).map((v) => v.code));
    }
    expect(statuses.filter((s) => s === 422).length).toBeGreaterThan(0);
    expect(rejectCodes).toContain('MAX_POSITION');
    await md.quote('EURUSD', '1.08900', '1.08902');
    await engine.matchSymbol('EURUSD');
    const acct = (await get(u, '/accounts/me')).body;
    expect(Number(acct.grossExposure)).toBeLessThanOrEqual(Number(acct.limits.maxPositionNotional));
    expect(Number(acct.leverage)).toBeLessThanOrEqual(Number(acct.limits.maxLeverage));
  });

  // ---- R2-02: marketable-on-amend limits take, post-only never takes, gaps fill at the market --------

  it('R2-02: post-only amended across the spread is refused; a crossed limit fills as a taker at the touch', async () => {
    const u = await createUser(app, 'trader');
    const po = await place(u, {
      symbol: 'EURUSD',
      side: 'buy',
      type: 'limit',
      qty: '100000',
      limitPrice: '1.08000',
      postOnly: true,
    });
    expect(po.body.order.status).toBe('working');
    const am = await patch(u, `/orders/${po.body.order.id}`, { limitPrice: '1.09400' });
    expect(am.status, JSON.stringify(am.body)).toBe(422);
    expect(am.body.code).toBe('POST_ONLY_WOULD_TAKE');
    expect((await get(u, `/orders/${po.body.order.id}`)).body.limitPrice).toBe('1.08');

    const plain = await place(u, {
      symbol: 'EURUSD',
      side: 'buy',
      type: 'limit',
      qty: '100000',
      limitPrice: '1.08000',
    });
    const am2 = await patch(u, `/orders/${plain.body.order.id}`, { limitPrice: '1.09400' });
    expect(am2.status).toBe(200);
    expect(am2.body.status).toBe('filled');
    const f = (await fills(u, 'EURUSD')).at(0)!;
    expect(f.liquidity).toBe('taker');
    expect(Number(f.price)).toBeLessThan(1.085);
  });

  it('R2-02: a resting limit gapped through after a pause fills at the market, not at its limit', async () => {
    const u = await createUser(app, 'trader');
    const o = await place(u, {
      symbol: 'EURUSD',
      side: 'buy',
      type: 'limit',
      qty: '100000',
      limitPrice: '1.08000',
    });
    expect(o.body.order.status).toBe('working');
    // Ten minutes without a matching pass (market paused), then the market opens below the limit.
    vi.setSystemTime(Date.now() + 600_000);
    await md.touch();
    await md.quote('EURUSD', '1.07898', '1.07900');
    await engine.matchSymbol('EURUSD');
    const done = (await get(u, `/orders/${o.body.order.id}`)).body;
    expect(done.status).toBe('filled');
    expect(Number(done.avgFillPrice)).toBeLessThanOrEqual(1.079);
  });

  // ---- R2-04: novice stop protection -----------------------------------------------------------------

  it('R2-04: a novice cannot cancel or widen the protective stop of an open position', async () => {
    const u = await createUser(app, 'novice');
    await acknowledgeRiskWarning(app, u.token);
    const o = await place(u, {
      symbol: 'BTCUSD',
      side: 'buy',
      type: 'market',
      qty: '0.01',
      stopLossPrice: '63000.0',
    });
    expect(o.status).toBe(201);
    const sl = (
      (await get(u, `/orders/${o.body.order.id}`)).body.children as Array<{
        id: string;
        role: string;
      }>
    ).find((c) => c.role === 'stop_loss')!;
    const widen = await patch(u, `/orders/${sl.id}`, { stopPrice: '61600.0' });
    expect(widen.status, JSON.stringify(widen.body)).toBe(422);
    expect(widen.body.code).toBe('NOVICE_STOP_REQUIRED');
    const qty = await patch(u, `/orders/${sl.id}`, { qty: '0.005' });
    expect(qty.status).toBe(422);
    const cancel = await del(u, `/orders/${sl.id}`);
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(422);
    expect(cancel.body.code).toBe('NOVICE_STOP_REQUIRED');
    const all = await del(u, '/orders');
    expect(all.status).toBe(200);
    expect((await get(u, `/orders/${sl.id}`)).body.status).toBe('working');
    // Tightening is allowed.
    const tighten = await patch(u, `/orders/${sl.id}`, { stopPrice: '63500.0' });
    expect(tighten.status).toBe(200);
    // Closing the trade removes the stop with the position.
    expect(
      (await place(u, { symbol: 'BTCUSD', side: 'sell', type: 'market', qty: '0.01' })).status,
    ).toBe(201);
    expect((await get(u, `/orders/${sl.id}`)).body.status).toBe('cancelled');
  });

  // ---- R2-05: base currency change converts cash and limits ------------------------------------------

  it('R2-05: changing the base currency converts the starting cash and the platform limits', async () => {
    const u = await createUser(app, 'trader');
    const r = await request(http)
      .put('/accounts/me/settings')
      .set(bearer(u.token))
      .send({ baseCurrency: 'JPY' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const a = (await get(u, '/accounts/me')).body;
    expect(a.baseCurrency).toBe('JPY');
    // 100,000 USD at USDJPY mid 148.215.
    expect(a.cash).toBe('14821500');
    expect(a.startingCash).toBe('14821500');
    expect(Number(a.limits.dailyLossLimit)).toBeCloseTo(5000 * 148.215, 0);
    expect(Number(a.limits.maxOrderNotional)).toBeCloseTo(1_000_000 * 148.215, 0);
    const led = await ownerQuery<{ cash: string; ledger: string }>(
      `SELECT a.cash::text AS cash, (SELECT sum(amount)::text FROM ledger_entries e WHERE e.account_id = a.id AND e.ledger_account = 'cash') AS ledger
       FROM accounts a WHERE a.user_id = $1`,
      [u.id],
    );
    expect(Number(led[0]!.ledger)).toBe(Number(led[0]!.cash));
  });

  // ---- R2-06: minimum commission once per order ------------------------------------------------------

  it('R2-06: the minimum commission is charged once per order, as the preview shows', async () => {
    const u = await createUser(app, 'trader');
    await md.depth(
      'AAPL',
      [['221.36', '100']],
      [
        ['221.38', '100'],
        ['221.39', '100'],
        ['221.40', '100'],
      ],
    );
    const pv = await preview(u, { symbol: 'AAPL', side: 'buy', type: 'market', qty: '300' });
    expect(pv.body.preview.fees.commission).toBe('1.50');
    expect(
      (await place(u, { symbol: 'AAPL', side: 'buy', type: 'market', qty: '300' })).status,
    ).toBe(201);
    const f = await fills(u, 'AAPL');
    expect(f.length).toBe(3);
    expect(f.reduce((s, x) => s + Number(x.commission), 0).toFixed(2)).toBe('1.50');

    const v = await createUser(app, 'trader');
    await md.depth(
      'AAPL',
      [['221.36', '100']],
      Array.from({ length: 9 }, (_, i) => [`221.${38 + i}`, '1'] as [string, string]).concat([
        ['221.47', '100'],
      ]),
    );
    const pv2 = await preview(v, { symbol: 'AAPL', side: 'buy', type: 'market', qty: '10' });
    expect(pv2.body.preview.fees.commission).toBe('1.00');
    await place(v, { symbol: 'AAPL', side: 'buy', type: 'market', qty: '10' });
    expect((await fills(v, 'AAPL')).reduce((s, x) => s + Number(x.commission), 0).toFixed(2)).toBe(
      '1.00',
    );
  });

  // ---- R2-08: daily loss baseline before the first request of the day --------------------------------

  it('R2-08: the day-start equity is snapshotted at the roll, so a loss before the first request counts', async () => {
    const u = await createUser(app, 'trader');
    {
      const r0 = await place(u, { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '900000' });
      expect(r0.status, JSON.stringify(r0.body)).toBe(201);
    }
    await new Promise((r) => setTimeout(r, 300)); // let the async account publish of the fill settle
    vi.setSystemTime(marketDay(1, '00:00:30')); // Thursday, just after the UTC day starts
    await md.standard();
    await engine.sweep(Date.now());
    vi.setSystemTime(marketDay(1));
    await relogin(u);
    await md.standard();
    await md.quote('EURUSD', '1.07600', '1.07602'); // the loss happens before the user's first request
    const more = await place(u, { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '100000' });
    expect(more.status, JSON.stringify(more.body)).toBe(422);
    expect((more.body.violations as Array<{ code: string }>).map((x) => x.code)).toContain(
      'DAILY_LOSS_LIMIT',
    );
  });

  // ---- R2-09: resume TOCTOU --------------------------------------------------------------------------

  it('R2-09: a firm halt that lands between the policy check and the resume is not lifted without four eyes', async () => {
    const u = await createUser(app, 'trader');
    const ro = await createUser(app, 'trader', ['risk_officer']);
    const ks = app.get(KillSwitchService);
    const accounts = app.get(AccountsService);
    await request(http)
      .post('/kill-switch')
      .set(bearer(u.token))
      .send({ scope: 'robots', source: 'ui_button' });
    const orig = ks.executeResume.bind(ks);
    const spy = vi
      .spyOn(ks, 'executeResume')
      .mockImplementationOnce(async (...args: Parameters<typeof orig>) => {
        await ks.triggerAccount(ro.id, await accounts.ensure(u.id), {
          scope: 'robots_cancel',
          source: 'risk_console',
          reason: 'firm halt',
        });
        return orig(...args);
      });
    const r = await request(http)
      .post('/kill-switch/resume')
      .set(bearer(u.token))
      .send({ reason: 'owner resume' });
    spy.mockRestore();
    expect(r.body.resumed).not.toBe(true);
    const after = await ownerQuery<{ trading_halted: boolean }>(
      'SELECT trading_halted FROM accounts WHERE user_id = $1',
      [u.id],
    );
    expect(after[0]!.trading_halted).toBe(true);
  });

  // ---- R2-10: volatility term is per quote, not sticky, not moved by previews ------------------------

  it('R2-10: a mid jump taxes only the quote it happened on; previews do not move the volatility term', async () => {
    const u = await createUser(app, 'trader');
    await md.quote('EURUSD', '1.09419', '1.09421'); // +100 pips
    await preview(u, { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '100000' });
    await md.touch(); // new quote, unchanged mid
    const b = await place(u, { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '100000' });
    expect(b.body.order.avgFillPrice).toBe('1.09421');
  });

  // ---- R2-11: trailing distance amend applies at once ------------------------------------------------

  it('R2-11: amending the trailing distance moves the stop at once', async () => {
    const u = await createUser(app, 'trader');
    await place(u, { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '10000' });
    const t = await place(u, {
      symbol: 'EURUSD',
      side: 'sell',
      type: 'trailing',
      qty: '10000',
      trailAmount: '0.00500',
      reduceOnly: true,
    });
    expect(t.body.order.stopPrice).toBe('1.07919');
    const am = await patch(u, `/orders/${t.body.order.id}`, { trailAmount: '0.00050' });
    expect(am.status).toBe(200);
    expect(am.body.stopPrice).toBe('1.08369');
    await md.quote('EURUSD', '1.08300', '1.08302');
    await engine.matchSymbol('EURUSD');
    expect((await get(u, `/orders/${t.body.order.id}`)).body.status).toBe('filled');
  });

  // ---- R2-12: kill switch scope 2 keeps protective stops ---------------------------------------------

  it('R2-12: kill switch "halt robots + cancel orders" keeps the protective stops of open positions', async () => {
    const u = await createUser(app, 'trader');
    await place(u, {
      symbol: 'EURUSD',
      side: 'buy',
      type: 'market',
      qty: '10000',
      stopLossPrice: '1.08000',
    });
    const entry = await place(u, {
      symbol: 'EURUSD',
      side: 'buy',
      type: 'limit',
      qty: '10000',
      limitPrice: '1.08000',
    });
    const ks = await request(http)
      .post('/kill-switch')
      .set(bearer(u.token))
      .send({ scope: 'robots_cancel', source: 'ui_button' });
    expect(ks.status).toBe(202);
    expect(ks.body.ordersCancelled).toBe(1);
    expect((await get(u, `/orders/${entry.body.order.id}`)).body.status).toBe('cancelled');
    const open = (await get(u, '/orders?status=open')).body.orders as Array<{
      role: string;
      status: string;
    }>;
    expect(open.map((o) => o.role)).toEqual(['stop_loss']);
  });

  // ---- R2-14: FX staleness never blocks risk-reducing actions ----------------------------------------

  it('R2-14: with FX closed (weekend) a non-USD account still gets its stop, can close, and flatten works', async () => {
    const eur = await createUser(app, 'trader');
    const eur2 = await createUser(app, 'trader');
    for (const u of [eur, eur2])
      await request(http)
        .put('/accounts/me/settings')
        .set(bearer(u.token))
        .send({ baseCurrency: 'EUR' });
    expect(
      (
        await place(eur, {
          symbol: 'BTCUSD',
          side: 'buy',
          type: 'market',
          qty: '0.5',
          stopLossPrice: '63000.0',
        })
      ).status,
    ).toBe(201);
    expect(
      (await place(eur2, { symbol: 'BTCUSD', side: 'buy', type: 'market', qty: '0.2' })).status,
    ).toBe(201);
    const friday = marketDay(2, '20:59:00').getTime();
    vi.setSystemTime(marketDay(3, '12:00:00')); // Saturday: FX closed, crypto trades
    await relogin(eur);
    await relogin(eur2);
    await md.status({ state: 'ok', feed: 'up', staleSymbols: [], ts: null });
    await md.quote('EURUSD', '1.08419', '1.08421', { receivedTs: friday });
    await md.quote('BTCUSD', '58000.0', '58002.0');
    await engine.matchSymbol('BTCUSD');
    expect(await position(eur, 'BTCUSD')).toBe('0');
    const stopFill = await ownerQuery<{ fx_stale: boolean }>(
      `SELECT f.fx_stale FROM fills f JOIN orders o ON o.id = f.order_id WHERE o.role = 'stop_loss' AND f.account_id = (SELECT id FROM accounts WHERE user_id = $1)`,
      [eur.id],
    );
    expect(stopFill[0]?.fx_stale).toBe(true);
    // A closing order is allowed with the last known rate; new exposure still needs a fresh rate.
    const rawPreview = (body: object) =>
      request(http).post('/orders/preview').set(bearer(eur2.token)).send(body);
    const close = await rawPreview({
      symbol: 'BTCUSD',
      side: 'sell',
      type: 'market',
      qty: '0.2',
      reduceOnly: true,
    });
    expect(
      (close.body.risk.violations as Array<{ code: string }>).map((v) => v.code),
    ).not.toContain('FX_RATE_UNAVAILABLE');
    const open = await rawPreview({
      symbol: 'BTCUSD',
      side: 'buy',
      type: 'market',
      qty: '0.2',
      stopLossPrice: '57000.0',
    });
    expect((open.body.risk.violations as Array<{ code: string }>).map((v) => v.code)).toContain(
      'FX_RATE_UNAVAILABLE',
    );
    const ks = await request(http)
      .post('/kill-switch')
      .set(bearer(eur2.token))
      .send({ scope: 'robots_cancel_flatten', source: 'ui_button' });
    expect(ks.body.positionsFlattened).toBe(1);
    expect(ks.body.flattenPending).toEqual([]);
  });

  // ---- R2-19: DAY orders on 24h venues end at the 17:00 New York roll -------------------------------

  it('R2-19: DAY orders on 24-hour venues end at the 17:00 New York roll, exchange venues unchanged', async () => {
    const reg = app.get(TradingRegistryService);
    const at = async (sym: string, iso: string) =>
      dayExpiry(await reg.get(sym), Date.parse(iso)).toISOString();
    expect(await at('EURUSD', '2026-09-28T14:00:00Z')).toBe('2026-09-28T21:00:00.000Z'); // Monday → Monday 17:00 NY
    expect(await at('EURUSD', '2026-09-28T22:00:00Z')).toBe('2026-09-29T21:00:00.000Z'); // after the roll → next roll
    expect(await at('US500', '2026-09-30T14:00:00Z')).toBe('2026-09-30T21:00:00.000Z');
    expect(await at('AAPL', '2026-09-30T14:00:00Z')).toBe('2026-09-30T20:00:00.000Z');
    expect(await at('EURUSD', '2026-12-01T14:00:00Z')).toBe('2026-12-01T22:00:00.000Z'); // winter time
    expect(await at('BTCUSD', '2026-09-30T14:00:00Z')).toBe('2026-10-01T00:00:00.000Z');
  });

  // ---- R2-20: margin call and close-out ----------------------------------------------------------------

  it('R2-20: margin call below 100% margin level, close-out of the largest loser below 50%', async () => {
    const u = await createUser(app, 'trader');
    for (let i = 0; i < 2; i++)
      expect(
        (await place(u, { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '900000' })).status,
      ).toBe(201);
    expect(
      (await place(u, { symbol: 'GBPUSD', side: 'buy', type: 'market', qty: '100000' })).status,
    ).toBe(201);
    const a0 = (await get(u, '/accounts/me')).body;
    const used = Number(a0.marginUsed);
    const eq0 = Number(a0.equity);
    // Drop EURUSD so that equity ≈ 0.8 × margin used (margin call, no close-out).
    const px = (targetEquity: number) => (1.08419 - (eq0 - targetEquity) / 1_800_000).toFixed(5);
    const p1 = px(0.8 * used);
    await md.quote('EURUSD', p1, (Number(p1) + 0.00002).toFixed(5));
    await engine.sweep(Date.now());
    const calls = await ownerQuery<{ kind: string }>(
      `SELECT kind FROM alerts WHERE account_id = (SELECT id FROM accounts WHERE user_id = $1) AND kind LIKE 'risk.margin%'`,
      [u.id],
    );
    expect(calls.map((c) => c.kind)).toContain('risk.margin_call');
    expect(await position(u, 'EURUSD')).toBe('1800000');
    // Drop further: equity ≈ 0.4 × margin used → close out EURUSD (largest loss), keep GBPUSD.
    const p2 = px(0.4 * used);
    await md.quote('EURUSD', p2, (Number(p2) + 0.00002).toFixed(5));
    await md.touch();
    await engine.sweep(Date.now());
    expect(await position(u, 'EURUSD')).toBe('0');
    expect(await position(u, 'GBPUSD')).toBe('100000');
    const co = await ownerQuery<{ source: string; actor_type: string }>(
      `SELECT o.source, e.actor_type FROM orders o JOIN audit_events e ON e.entity_id = o.id::text AND e.action = 'order.new'
       WHERE o.account_id = (SELECT id FROM accounts WHERE user_id = $1) AND o.source = 'margin-closeout'`,
      [u.id],
    );
    expect(co[0]).toMatchObject({ source: 'margin-closeout', actor_type: 'system' });
  });

  // ---- Lows ---------------------------------------------------------------------------------------------

  it('R2-18: a zero own limit is refused (no NaN in the account view)', async () => {
    const u = await createUser(app, 'trader');
    const r = await request(http)
      .put('/accounts/me/settings')
      .set(bearer(u.token))
      .send({ riskLimits: { dailyLossLimit: '0' } });
    expect(r.status).toBe(400);
    expect((await get(u, '/accounts/me')).body.dailyLossUsedPct).not.toBe('NaN');
  });

  it('R2-26: a robot cannot amend orders while the account is halted', async () => {
    const u = await createUser(app, 'trader');
    await place(u, {
      symbol: 'EURUSD',
      side: 'buy',
      type: 'market',
      qty: '10000',
      stopLossPrice: '1.08000',
    });
    const sl = (
      (await get(u, '/orders?status=open')).body.orders as Array<{ id: string; role: string }>
    ).find((o) => o.role === 'stop_loss')!;
    await request(http)
      .post('/kill-switch')
      .set(bearer(u.token))
      .send({ scope: 'robots', source: 'ui_button' });
    const oms = app.get(OmsService);
    await expect(
      oms.amend(
        u.id,
        u.roles,
        sl.id,
        { stopPrice: '1.08100' },
        { type: 'robot', id: '00000000-0000-4000-8000-000000000001' },
      ),
    ).rejects.toMatchObject({
      response: { code: 'TRADING_HALTED' },
    });
  });

  it('R2-15: consecutive orders on one depth snapshot do not re-use the same liquidity', async () => {
    const depth: [string, string][] = [
      ['1.08421', '100000'],
      ['1.08431', '100000'],
      ['1.08441', '100000'],
      ['1.08451', '1000000'],
    ];
    const u = await createUser(app, 'trader');
    await md.touch();
    await md.depth('EURUSD', [['1.08419', '1000000']], depth);
    const px: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await request(http)
        .post('/orders')
        .set(bearer(u.token))
        .send({
          clientOrderId: cid(),
          symbol: 'EURUSD',
          side: 'buy',
          type: 'market',
          qty: '100000',
          tif: 'ioc',
        });
      px.push(r.body.order.avgFillPrice as string);
    }
    expect(px).toEqual(['1.08421', '1.08431', '1.08441']);
  });

  it('R2-07: charges are booked in the account currency minor unit (JPY: whole yen)', async () => {
    const u = await createUser(app, 'trader');
    await request(http)
      .put('/accounts/me/settings')
      .set(bearer(u.token))
      .send({ baseCurrency: 'JPY' });
    await place(u, { symbol: 'EURUSD', side: 'buy', type: 'market', qty: '3000' });
    await place(u, { symbol: 'EURUSD', side: 'sell', type: 'market', qty: '3000' });
    for (const f of await fills(u, 'EURUSD')) {
      expect(f.commission).toMatch(/^\d+$/);
      expect(f.fxConversionCost).toMatch(/^\d+$/);
    }
  });
});
