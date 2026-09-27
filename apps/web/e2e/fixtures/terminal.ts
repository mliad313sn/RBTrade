import type { Page, WebSocketRoute } from '@playwright/test';

/**
 * Deterministic SIMULATED fixtures for the visual regression run (goal 04). REST calls from the
 * browser are answered here and the market data WebSocket is replaced by a mock that answers
 * subscriptions with fixed snapshots, so the render does not depend on the live simulator, the
 * wall clock or the weekday. Values echo the prototype artboard (Main.png); they are test data only.
 */

export const FIXED_NOW = Date.parse('2026-09-28T11:07:32Z'); // a Monday, FX and crypto open

interface Spec {
  symbol: string;
  pricePrecision: number;
  tickSize: string;
  [k: string]: unknown;
}

const MIDS: Record<string, [mid: number, changePct: number, spreadTicks: number]> = {
  EURUSD: [1.0842, 0.18, 2],
  GBPUSD: [1.26412, -0.07, 3],
  USDJPY: [148.215, 0.22, 3],
  XAUUSD: [2395.4, 0.41, 4],
  BTCUSD: [64812.5, -1.35, 10],
  ETHUSD: [3104.2, -0.92, 6],
  US500: [5482.6, 0.12, 5],
  NAS100: [19640.1, 0.31, 10],
  AAPL: [221.37, -0.44, 2],
  NVDA: [118.92, 1.87, 2],
  WTI: [78.14, -0.63, 3],
};
export const MAJORS = Object.keys(MIDS);

const fmt = (v: number, p: number) => v.toFixed(p);

function quoteFor(spec: Spec) {
  const [mid, , spread] = MIDS[spec.symbol] ?? [100, 0, 2];
  const tick = Number(spec.tickSize);
  const half = (spread * tick) / 2;
  return {
    type: 'quote',
    symbol: spec.symbol,
    bid: fmt(mid - half, spec.pricePrecision),
    ask: fmt(mid + half, spec.pricePrecision),
    bidSize: '1000000',
    askSize: '1000000',
    stale: false,
    source: 'simulated',
    exchangeTs: FIXED_NOW,
    receivedTs: FIXED_NOW,
    seq: 1,
  };
}

function dayOpenFor(spec: Spec): string {
  const [mid, chg] = MIDS[spec.symbol] ?? [100, 0];
  return fmt(mid / (1 + chg / 100), spec.pricePrecision);
}

/** 15-minute EUR/USD candles: a deterministic dip-and-rally like the artboard. */
function candles(): Array<{ t: number; open: string; high: string; low: string; close: string; volume: string; trades: number }> {
  const out = [];
  const n = 96;
  const end = Math.floor(FIXED_NOW / 900_000) * 900_000;
  let prev = 1.0831;
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    const trend = 1.0831 - 0.0022 * Math.sin(Math.PI * Math.min(1, x * 1.6)) + (x > 0.62 ? (x - 0.62) * 0.0029 : 0);
    const wiggle = 0.00018 * Math.sin(i * 1.7) + 0.00012 * Math.cos(i * 0.9);
    const close = trend + wiggle;
    const open = prev;
    const high = Math.max(open, close) + 0.00008 + 0.00005 * Math.abs(Math.sin(i * 2.3));
    const low = Math.min(open, close) - 0.00008 - 0.00005 * Math.abs(Math.cos(i * 1.9));
    out.push({ t: end - (n - 1 - i) * 900_000, open: fmt(open, 5), high: fmt(high, 5), low: fmt(low, 5), close: fmt(close, 5), volume: String(Math.round(400 + 300 * Math.abs(Math.sin(i * 0.7)))), trades: 10 });
    prev = close;
  }
  return out;
}

function depth() {
  const bids: Array<[string, string]> = [];
  const asks: Array<[string, string]> = [];
  const sizes = ['3100000', '1800000', '6200000', '2400000', '4400000', '2100000', '3300000', '1500000', '2700000', '3900000'];
  for (let i = 0; i < 10; i++) {
    bids.push([fmt(1.08419 - i * 0.00002, 5), sizes[i]!]);
    asks.push([fmt(1.08421 + i * 0.00002, 5), sizes[(i + 3) % 10]!]);
  }
  return { type: 'depth_snapshot', symbol: 'EURUSD', bids, asks, source: 'simulated', exchangeTs: FIXED_NOW, receivedTs: FIXED_NOW, seq: 1 };
}

const ACCOUNT_ID = '0b3c9a4e-1f2d-4c5b-9a8e-7d6c5b4a3f21';
const iso = (msAgo: number) => new Date(FIXED_NOW - msAgo).toISOString();

function account() {
  return {
    id: ACCOUNT_ID, environment: 'PAPER', simulated: true, baseCurrency: 'USD', marginTier: 'retail', status: 'active',
    startingCash: '250000.00', cash: '248916.63', equity: '250000.00', unrealizedPnl: '1083.37', dayPnl: '1284.50', weekPnl: '1284.50',
    marginUsed: '42676.37', marginFree: '207323.63', marginUsedPct: '17.07', grossExposure: '420000.00', leverage: '1.68',
    dailyLossLimit: '5000.00', dailyLossUsedPct: '22.00', openPositions: 4, unpriced: [],
    halt: { halted: false, scope: null, haltedAt: null, haltedBy: null, reason: null },
    limits: { maxOrderNotional: '1000000', maxPositionNotional: '2000000', maxLeverage: '30', dailyLossLimit: '5000', weeklyLossLimit: '10000', maxOrdersPerMinute: 60 },
    settings: { confirmMode: 'above_thresholds', confirmNotionalAbove: '50000', confirmLossPctAbove: '1' },
    asOf: new Date(FIXED_NOW).toISOString(),
  };
}

function positions() {
  // IRTC R5-02: the account and the positions describe the same book (equity = cash + Σ unrealized,
  // margin = Σ position margin), because the terminal now derives the top bar from the positions.
  const p = (symbol: string, qty: string, avgPrice: string, markPrice: string, unrealizedPnl: string, notional: string, marginUsed: string) => ({
    accountId: ACCOUNT_ID, symbol, qty, avgPrice, markPrice, quoteCcy: 'USD', unrealizedPnl, realizedPnl: '0.00', notional, marginUsed, updatedAt: iso(3_600_000), stale: false,
  });
  return [
    p('EURUSD', '200000', '1.08120', '1.08420', '599.37', '216840.00', '7220.77'),
    p('XAUUSD', '-20', '2401.10', '2395.40', '114.00', '47908.00', '2395.40'),
    p('NVDA', '300', '121.40', '118.92', '-744.00', '35676.00', '7135.20'),
    p('BTCUSD', '0.8', '63420.0', '64812.5', '1114.00', '51850.00', '25925.00'),
  ];
}

function order(id: string, symbol: string, side: 'buy' | 'sell', limitPrice: string, qty: string) {
  return {
    id, accountId: ACCOUNT_ID, clientOrderId: `fx-${id.slice(0, 4)}`, parentOrderId: null, ocoGroup: null, role: 'primary', symbol, side, type: 'limit', execType: 'limit',
    qty, filledQty: '0', avgFillPrice: null, limitPrice, stopPrice: null, trailAmount: null, stopLossPrice: null, takeProfitPrice: null, tif: 'gtc', expireAt: null,
    reduceOnly: false, postOnly: false, source: 'manual', status: 'working', rejectCode: null, rejectMessage: null, cancelReason: null, triggeredAt: null, createdAt: iso(1_800_000), updatedAt: iso(1_800_000),
  };
}

const ORDERS = [order('11111111-1111-4111-8111-111111111111', 'EURUSD', 'buy', '1.08180', '100000'), order('22222222-2222-4222-8222-222222222222', 'AAPL', 'sell', '224.50', '50')];

const CAL = [
  { id: 'c1', time: '2026-09-28T12:30:00Z', country: 'US', currency: 'USD', impact: 3, title: 'US CPI (m/m)', source: 'simulated' },
  { id: 'c2', time: '2026-09-28T14:00:00Z', country: 'EU', currency: 'EUR', impact: 2, title: 'ECB speaker', source: 'simulated' },
  { id: 'c3', time: '2026-09-28T18:00:00Z', country: 'US', currency: 'USD', impact: 1, title: 'FOMC minutes', source: 'simulated' },
];

/** Goal 07 strip, SIMULATED values echoing the prototype (calibrated confidence, drivers, event risk). */
const AI_STRIP = {
  symbol: 'EURUSD',
  timeframe: '15m',
  simulated: true,
  bias: { direction: 'long', label: 'Mild long bias', score: 0.58 },
  confidence: { value: 0.58, n: 212, saidAs: 0.6, bin: 5 },
  reliabilityLine: 'When we said 0.6, it worked 58% of the time (n=212)',
  edge: 'positive',
  edgeStatement: 'Positive after costs on past predictions, which does not guarantee future results.',
  calibration: { modelKey: 'bias:EURUSD:15m', n: 1840, hitRate: 0.54, minN: 30, source: 'fixture' },
  drivers: [
    { key: 'momentum', label: '4-bar momentum (ATR multiples)', value: 0.9, contribution: 0.36 },
    { key: 'emaSpread', label: 'EMA 20 vs EMA 50 (ATR multiples)', value: 0.3, contribution: 0.24 },
    { key: 'rsi', label: 'RSI 14 vs 50', value: -0.1, contribution: -0.06 },
  ],
  eventRisk: [{ time: '2026-09-28T12:30:00Z', currency: 'USD', title: 'US CPI', minutesAway: 83 }],
  canDraft: true,
  disclaimer: 'Not investment advice.',
  method: 'fixture',
};

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

/** Installs the REST + WebSocket fixtures on a signed-in page (registry specs come from the real api). */
export async function installTerminalFixtures(page: Page): Promise<void> {
  const reg = (await (await page.request.get('/api/instruments')).json()) as { instruments: Spec[] };
  const ven = (await (await page.request.get('/api/venues')).json()) as { venues: Array<Record<string, unknown>> };
  const openSession = { state: 'open', localDate: '2026-09-28', localTime: '11:07', nextChange: null, nextState: null };
  const instruments = reg.instruments.map((i) => ({ ...i, session: { ...openSession, timezone: 'UTC', source: 'venue' } }));
  const venues = ven.venues.map((v) => ({ ...v, session: openSession }));
  const bySymbol = new Map(instruments.map((i) => [i.symbol, i]));

  await page.clock.setFixedTime(FIXED_NOW);
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, '');
    const method = route.request().method();
    if (path === '/instruments') return route.fulfill(json({ instruments }));
    if (path === '/venues') return route.fulfill(json({ venues }));
    if (path.startsWith('/instruments/')) {
      const s = bySymbol.get(decodeURIComponent(path.split('/')[2]!));
      return s ? route.fulfill(json({ ...s, staleAfterMs: 5000, venueInfo: null })) : route.fulfill({ status: 404, body: '{}' });
    }
    if (path === '/quotes') {
      const syms = (url.searchParams.get('symbols') ?? '').split(',').filter(Boolean);
      return route.fulfill(json({ quotes: syms.map((s) => ({ symbol: s, quote: bySymbol.has(s) ? quoteFor(bySymbol.get(s)!) : null, dayOpen: bySymbol.has(s) ? dayOpenFor(bySymbol.get(s)!) : null })) }));
    }
    if (path === '/candles') return route.fulfill(json({ symbol: url.searchParams.get('symbol'), tf: url.searchParams.get('tf'), simulated: true, source: 'fixture', candles: url.searchParams.get('symbol') === 'EURUSD' ? candles() : [] }));
    if (path === '/accounts/me') return route.fulfill(json(account()));
    if (path === '/positions') return route.fulfill(json({ accountId: ACCOUNT_ID, currency: 'USD', positions: positions() }));
    if (path === '/orders' && method === 'GET') return route.fulfill(json({ accountId: ACCOUNT_ID, orders: ORDERS }));
    if (path === '/fills') return route.fulfill(json({ accountId: ACCOUNT_ID, currency: 'USD', fills: [] }));
    if (path === '/me/watchlists') return route.fulfill(json({ watchlists: [{ id: '33333333-3333-4333-8333-333333333333', name: 'Majors', position: 0, symbols: MAJORS, updatedAt: iso(0) }] }));
    if (path === '/me/layouts') return route.fulfill(json({ layouts: [] }));
    if (path === '/calendar') return route.fulfill(json({ source: 'simulated', simulated: true, events: CAL }));
    if (path === '/price-alerts') return route.fulfill(json({ alerts: [] }));
    if (path === '/health') return route.fulfill(json({ status: 'ok', service: 'kora-api', environment: 'PAPER', liveTradingEnabled: false, authProvider: 'dev', checks: {}, time: new Date(FIXED_NOW).toISOString() }));
    if (path === '/ai/strip') return route.fulfill(json(AI_STRIP));
    if (path === '/orders/preview') return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'fixture', message: 'Preview is not part of the visual fixture' }) });
    return route.continue();
  });

  await page.routeWebSocket(/\/ws$/, (ws: WebSocketRoute) => {
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw)) as { op?: string; channels?: string[] };
      if (msg.op !== 'subscribe') return;
      for (const ch of msg.channels ?? []) {
        let data: unknown = null;
        const [kind, sym] = ch.split(':');
        if (ch === 'status') data = { type: 'status', state: 'ok', ts: FIXED_NOW, feeds: [{ source: 'simulated', state: 'up', lastMessageTs: FIXED_NOW, gaps: 0, resyncs: 0, lastResync: null }], staleSymbols: [], reason: null };
        else if (kind === 'quotes' && sym && bySymbol.has(sym)) data = quoteFor(bySymbol.get(sym)!);
        else if (kind === 'depth' && sym === 'EURUSD') data = depth();
        if (data) ws.send(JSON.stringify({ ch, snapshot: true, data }));
      }
    });
  });
}
