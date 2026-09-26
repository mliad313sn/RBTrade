import { TREND_X } from '@kora/domain';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

import { apiSignIn } from './helpers';

/**
 * Goal 07 copilot flows through the real web + api (scripted provider, SIMULATED data):
 * 1. terminal AI strip: confidence from a seeded calibration table, "No edge after costs",
 *    "Draft to ticket" pre-fills the ticket and placing still needs the preview + confirmation;
 * 2. robots copilot drawer: feature chart from stored data, streamed "why" answer, calibrated
 *    confidence, suggestion → unapproved draft → the human saves the version, no-edge scan, chat.
 */
const CSRF = { 'x-kora-csrf': '1' };
const M15 = 15 * 60_000;

async function db<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
  const url = process.env.DATABASE_URL_MIGRATE_E2E;
  if (!url) throw new Error('DATABASE_URL_MIGRATE_E2E is not set');
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows as T[];
  } finally {
    await c.end();
  }
}

/**
 * SIMULATED BTC 15m history ending in a steady rise up to the live SIMULATED quote (the strip's bias
 * is clearly long, and the live candle continues the series).
 */
async function seedBtc15m(last: number): Promise<void> {
  const now = Math.floor(Date.now() / M15) * M15;
  const n = 300;
  const rise = 30;
  const rows: Array<[number, string, string, string, string]> = [];
  const closeAt = (i: number) =>
    i >= n - rise
      ? last - (n - 1 - i) * 12
      : last - rise * 12 + 150 * Math.sin((2 * Math.PI * i) / 40) - 150;
  let prev = closeAt(0);
  for (let i = 0; i < n; i++) {
    const c = Math.round(closeAt(i) * 10) / 10;
    const o = prev;
    rows.push([
      now - (n - 1 - i) * M15,
      o.toFixed(1),
      (Math.max(o, c) + 4).toFixed(1),
      (Math.min(o, c) - 4).toFixed(1),
      c.toFixed(1),
    ]);
    prev = c;
  }
  await db(
    `INSERT INTO md_candles_history (symbol, tf, bucket, open, high, low, close, volume, trades, source)
     SELECT 'BTCUSD', '15m', to_timestamp(b / 1000.0), o, h, l, c, 1, 1, 'e2e-simulated'
     FROM unnest($1::bigint[], $2::numeric[], $3::numeric[], $4::numeric[], $5::numeric[]) AS x(b, o, h, l, c)
     ON CONFLICT (symbol, tf, bucket) DO UPDATE SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close`,
    [
      rows.map((r) => r[0]),
      rows.map((r) => r[1]),
      rows.map((r) => r[2]),
      rows.map((r) => r[3]),
      rows.map((r) => r[4]),
    ],
  );
}

async function seedCalibration(key: string): Promise<void> {
  await db('DELETE FROM ai_calibration_bins WHERE model_key = $1', [key]);
  for (let b = 0; b < 10; b++) {
    await db(
      `INSERT INTO ai_calibration_bins (model_key, bin, lo, hi, n, hits, mean_predicted, mean_net_return, net_return_sd, source)
       VALUES ($1, $2, $3, $4, 212, 121, $5, -0.02, 1.1, 'seed')`,
      [key, b, (b / 10).toFixed(2), ((b + 1) / 10).toFixed(2), b / 10 + 0.05],
    );
  }
}

async function openTerminal(page: Page, symbol: string) {
  await page.goto(`/terminal?symbol=${symbol}`);
  await expect(page.getByTestId('order-ticket')).toBeVisible({ timeout: 20_000 });
}

test('terminal AI strip: calibrated confidence from the table → Draft to ticket → preview and confirmation still required', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await apiSignIn(page, 'trader');
  await expect
    .poll(
      async () =>
        (
          (await (await page.request.get('/api/quotes?symbols=BTCUSD')).json()) as {
            quotes: Array<{ quote: { bid: string } | null }>;
          }
        ).quotes[0]!.quote !== null,
      { timeout: 20_000 },
    )
    .toBe(true);
  const q = (
    (await (await page.request.get('/api/quotes?symbols=BTCUSD')).json()) as {
      quotes: Array<{ quote: { bid: string; ask: string } }>;
    }
  ).quotes[0]!.quote;
  await seedBtc15m((Number(q.bid) + Number(q.ask)) / 2);
  await seedCalibration('bias:BTCUSD:15m');
  expect(
    (
      await page.request.put('/api/accounts/me/settings', {
        headers: CSRF,
        data: { confirmMode: 'always' },
      })
    ).status(),
  ).toBe(200);
  await openTerminal(page, 'BTCUSD');

  const strip = page.getByTestId('ai-strip');
  await expect(strip.getByTestId('ai-strip-bias')).toContainText(/long bias/i, { timeout: 20_000 });
  await expect(strip.getByTestId('ai-strip-confidence')).toHaveText('0.57');
  await expect(strip.getByTestId('ai-strip-bias')).toContainText('(calibrated, n=212)');
  await expect(strip.getByTestId('ai-strip-noedge')).toContainText('No edge after costs.');
  await expect(strip.getByTestId('ai-strip-drivers')).toContainText(/EMA 20\/50 [▲▼]/);

  await strip.getByTestId('ai-strip-why-toggle').click();
  if (process.env.E2E_SHOTS) await page.screenshot({ path: 'test-results/copilot-strip.png' });
  await expect(page.getByTestId('ai-strip-reliability')).toHaveText(
    /^When we said 0\.\d+, it worked 57% of the time \(n=212\)$/,
  );
  await strip.getByTestId('ai-strip-why-toggle').click();

  // Draft to ticket: the ticket is pre-filled with an AI draft, nothing is placed.
  await strip.getByTestId('ai-strip-draft').click();
  const ticket = page.getByTestId('order-ticket');
  await expect(ticket.getByTestId('ticket-note')).toContainText('AI draft');
  await expect(ticket.getByTestId('ticket-side-buy')).toHaveAttribute('aria-checked', 'true');
  await expect(ticket.getByTestId('ticket-qty')).not.toHaveValue('');
  const before = await (await page.request.get('/api/orders?status=all')).json();
  expect(before.orders).toHaveLength(0);

  // Placing still goes through the normal review → confirmation dialog.
  await ticket.getByTestId('place-order').click();
  const confirm = page.getByTestId('confirm-order');
  await expect(confirm).toBeVisible();
  // Market orders above the threshold need a hold; otherwise a plain confirm button.
  const hold = confirm.getByTestId('confirm-hold');
  if (await hold.count()) {
    await hold.focus();
    await page.keyboard.down('Space');
    await page.waitForTimeout(800);
    await page.keyboard.up('Space');
  } else {
    await confirm.getByTestId('confirm-place').click();
  }
  await expect(ticket.getByTestId('ticket-result')).toContainText(
    /Order (filled|working|accepted|rejected|pending)/i,
    { timeout: 15_000 },
  );
  const after = (await (await page.request.get('/api/orders?status=all')).json()) as {
    orders: Array<{ id: string; source: string; role?: string; parentOrderId?: string | null }>;
  };
  expect(after.orders.length).toBeGreaterThan(0);
  expect(after.orders.every((o) => o.source === 'ai-draft-accepted')).toBe(true);
  const ids = after.orders.map((o) => o.id);
  // The human decision is recorded against the draft (audited).
  await expect
    .poll(async () => {
      const ev = await db<{ n: string }>(
        `SELECT count(*)::text n FROM audit_events WHERE action = 'ai.draft_accepted' AND payload->>'orderId' = ANY($1::text[])`,
        [ids],
      );
      return Number(ev[0]!.n);
    })
    .toBe(1);
});

test('robots copilot drawer: feature chart from data, streamed why, calibrated confidence, suggestion → draft → human saves, no-edge scan, chat', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`${e.message}\n${e.stack ?? ''}`));
  await apiSignIn(page, 'trader');
  const s = await page.request.post('/api/strategies', {
    headers: CSRF,
    data: { definition: { ...TREND_X, name: 'Trend-X' } },
  });
  expect(s.status()).toBe(201);
  const strategy = (await s.json()) as { id: string; latest: { id: string } };
  const r = await page.request.post('/api/robots', {
    headers: CSRF,
    data: { name: 'Trend-X', versionId: strategy.latest.id },
  });
  expect(r.status()).toBe(201);
  const robotId = ((await r.json()) as { id: string }).id;
  const owner = await db<{ owner_id: string }>('SELECT owner_id FROM robots WHERE id = $1', [
    robotId,
  ]);
  const bar = new Date(
    Math.floor(Date.now() / 86_400_000) * 86_400_000 + 9 * 3_600_000,
  ).toISOString();
  await db(
    `INSERT INTO robot_signals (robot_id, version_id, symbol, bar_ts, action, reason, conditions, features, outcome)
     VALUES ($1, $2, 'EURUSD', $3, 'enter_long', 'entry conditions met', $4, $5, 'none')`,
    [
      robotId,
      strategy.latest.id,
      bar,
      JSON.stringify([
        {
          block: 'entry',
          index: 0,
          type: 'cross',
          label: 'EMA 20 crosses above EMA 50',
          result: true,
          values: { 'EMA 20': 1.08412, 'EMA 50': 1.08377 },
          contribution: 0.34,
          skipped: false,
        },
        {
          block: 'entry',
          index: 1,
          type: 'compare',
          label: 'ADX 14 > 22',
          result: true,
          values: { 'ADX 14': 26.4 },
          contribution: 0.12,
          skipped: false,
        },
        {
          block: 'entry',
          index: 2,
          type: 'ai_regime',
          label: 'AI regime = trending (p > 0.6)',
          result: 'not_available',
          values: {},
          contribution: null,
          skipped: true,
        },
        {
          block: 'filter',
          index: 0,
          type: 'no_event',
          label: 'No high-impact event within 60 min',
          result: true,
          values: {},
          contribution: -0.09,
          skipped: false,
        },
      ]),
      JSON.stringify({ 'ema:20': 1.08412, 'ema:50': 1.08377, 'adx:14': 26.4 }),
    ],
  );
  // A SIMULATED backtest: OOS Sharpe well below in-sample, OOS trades net of costs with no edge.
  const H = 3_600_000;
  const t0 = Date.now() - 400 * H;
  const trades = Array.from({ length: 70 }, (_, i) => ({
    symbol: 'EURUSD',
    side: 'long',
    qty: '10000',
    segment: i < 10 ? 'is' : 'oos',
    entryTs: t0 + i * H,
    entryPrice: '1.08000',
    exitTs: t0 + (i + 3) * H,
    exitPrice: i % 2 ? '1.08040' : '1.07945',
    reason: i % 2 ? 'target' : 'stop',
    grossPnl: i % 2 ? 42 : -53,
    commission: 2,
    swap: 0,
    netPnl: i % 2 ? 40 : -55,
    rMultiple: i % 2 ? 0.8 : -1.1,
    barsHeld: 3,
    entrySignal: { conditions: [{ result: true, contribution: 0.25 }] },
  }));
  const metrics = (sharpe: number, n: number) => ({
    bars: 200,
    trades: n,
    cagr: 0.05,
    sharpe,
    sortino: sharpe * 1.3,
    calmar: 0.6,
    maxDrawdown: -0.12,
    maxDrawdownDays: 30,
    winRate: 0.5,
    profitFactor: 1.05,
    expectancyR: -0.15,
    expectancyCcy: -7.5,
    exposurePct: 35,
    turnover: 4,
    costDragPct: 2,
    netPnl: -450,
  });
  const n = 80;
  const result = {
    kind: 'backtest',
    oosStart: t0 + 10 * H,
    metrics: { inSample: metrics(1.62, 10), outOfSample: metrics(1.01, 60), all: metrics(1.1, 70) },
    warnings: [],
    overfitting: { trials: 1, dsr: null, sr0: null },
    equity: {
      t: Array.from({ length: n }, (_, i) => t0 + i * H),
      equity: Array.from({ length: n }, (_, i) => 100000 + 30 * Math.sin(i / 5)),
      drawdown: Array.from({ length: n }, () => 0),
    },
    trades,
    guard: { passed: true, checkpoints: 4 },
    baseCurrency: 'USD',
    symbols: ['EURUSD'],
    timeframe: '1h',
  };
  await db(
    `INSERT INTO backtest_runs (strategy_id, version_id, user_id, kind, request, summary, result) VALUES ($1, $2, $3, 'backtest', '{}', $4, $5)`,
    [
      strategy.id,
      strategy.latest.id,
      owner[0]!.owner_id,
      JSON.stringify({
        oosTrades: 60,
        isTrades: 10,
        oosSharpe: 1.01,
        isSharpe: 1.62,
        symbols: 'EURUSD',
        timeframe: '1h',
        bars: 200,
      }),
      JSON.stringify(result),
    ],
  );

  await page.goto(`/robots?robot=${robotId}`);
  const drawer = page.getByTestId('robot-copilot');
  await expect(drawer.getByTestId('feature-chart'))
    .toBeVisible({ timeout: 20_000 })
    .catch((e: Error) => {
      throw new Error(`${e.message}\npage errors: ${errors.join('\n')}`);
    });
  await expect(drawer.getByTestId('feature-value').first()).toHaveText('▲ +0.34');
  await expect(drawer.getByTestId('feature-value').nth(2)).toHaveText('n/a');
  await expect(drawer.getByTestId('feature-value').nth(3)).toHaveText('▼ −0.09');

  await drawer.getByTestId('why-explain').click();
  const why = drawer.getByTestId('why-answer');
  await expect(why).toContainText('EMA 20 = 1.08412', { timeout: 15_000 });
  await expect(why).toContainText('ADX 14 = 26.4');
  await expect(why).toContainText('Not investment advice.');

  await expect(drawer.getByTestId('robot-edge')).toContainText('No edge after costs.');
  const reduce = drawer.getByTestId('suggestion-reduce_risk_until_live_evidence');
  await expect(reduce).toContainText('Reduce risk until 100 live trades');
  await reduce.getByTestId('suggestion-create-draft').click();
  await expect(drawer.getByTestId('strategy-draft')).toContainText('risk_pct: 0.75 → 0.5');
  const versionsBefore = await db<{ n: string }>(
    'SELECT count(*)::text n FROM strategy_versions WHERE strategy_id = $1',
    [strategy.id],
  );
  expect(versionsBefore[0]!.n).toBe('1');
  await drawer.getByTestId('strategy-draft-save').click();
  await expect(drawer.getByTestId('copilot-notice')).toContainText('Saved as v2');
  const author = await db<{ author_id: string }>(
    'SELECT author_id FROM strategy_versions WHERE strategy_id = $1 AND version = 2',
    [strategy.id],
  );
  expect(author[0]!.author_id).toBe(owner[0]!.owner_id);

  await drawer.getByTestId('scan-no-edge').click();
  await expect(drawer.getByTestId('scan-results')).toContainText('Trend-X');
  if (process.env.E2E_SHOTS)
    await page.screenshot({ path: 'test-results/copilot-drawer.png', fullPage: true });

  await drawer.getByTestId('copilot-input').fill('Why did Trend-X go long EUR/USD at 09:00?');
  await drawer.getByTestId('copilot-ask').click();
  const answer = drawer.getByTestId('copilot-answer');
  await expect(answer).toHaveAttribute('data-status', 'ok', { timeout: 15_000 });
  await expect(answer).toContainText('EMA 50 = 1.08377');
  await expect(answer).toContainText('+0.12');
});
