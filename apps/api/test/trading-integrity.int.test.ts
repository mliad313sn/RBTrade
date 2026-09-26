import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { LiveBrokerStub, LiveTradingDisabledError } from '../src/trading/broker/broker';
import { EngineLoopService } from '../src/trading/engine-loop.service';
import { ReconciliationService } from '../src/trading/reconciliation.service';
import { appQuery, bearer, createUser, ownerQuery, startApp, type TestUser } from './helpers';
import { MARKET_OPEN_UTC, MarketFixture } from './market-fixture';

let n = 0;
const cid = () => `i-${process.pid}-${++n}`;

/** Reconciliation, ledger invariants in the database, daily roll, and the LIVE guard. */
describe('trading integrity', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  const md = new MarketFixture();

  beforeAll(async () => {
    process.env.KORA_ENGINE_ENABLED = 'false';
    process.env.KORA_RECONCILIATION_INTERVAL_MS = '0';
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(MARKET_OPEN_UTC);
    app = await startApp();
    http = app.getHttpServer();
  });
  afterAll(async () => {
    await md.close();
    await app.close();
    vi.useRealTimers();
    delete process.env.KORA_ENGINE_ENABLED;
    delete process.env.KORA_RECONCILIATION_INTERVAL_MS;
  });

  const buy = async (u: TestUser, symbol: string, qty: string) => {
    await md.touch();
    return request(http).post('/orders').set(bearer(u.token)).send({ clientOrderId: cid(), symbol, side: 'buy', type: 'market', qty }).expect(201);
  };

  it('reconciliation is clean after trading and raises a critical alert on a position or cash mismatch', async () => {
    await md.standard();
    const u = await createUser(app, 'trader');
    await buy(u, 'EURUSD', '30000');
    await buy(u, 'EURUSD', '20000');
    await buy(u, 'SAP.XETR', '10');
    const clean = await request(http).post('/reconciliation/run').set(bearer(u.token)).expect(200);
    expect(clean.body).toMatchObject({ trigger: 'manual', accountsChecked: 1, mismatches: [] });

    const acct = (await request(http).get('/accounts/me').set(bearer(u.token)).expect(200)).body;
    await ownerQuery(`UPDATE positions SET qty = qty + 1000 WHERE account_id = $1 AND symbol = 'EURUSD'`, [acct.id]);
    await ownerQuery(`UPDATE accounts SET cash = cash + 1 WHERE id = $1`, [acct.id]);
    const run = await app.get(ReconciliationService).run('schedule');
    const mine = run!.mismatches.filter((m) => m.accountId === acct.id);
    expect(mine.map((m) => m.kind).sort()).toEqual(['cash', 'position_qty']);
    expect(mine.find((m) => m.kind === 'position_qty')).toMatchObject({ symbol: 'EURUSD', engine: '51000', broker: '50000' });
    const alerts = (await request(http).get('/alerts').set(bearer(u.token)).expect(200)).body.alerts;
    expect(alerts[0]).toMatchObject({ severity: 'critical', kind: 'reconciliation.mismatch', account_id: acct.id });
    const audit = await ownerQuery<{ payload: { severity: string } }>(`SELECT payload FROM audit_events WHERE action = 'reconciliation.mismatch' AND entity_id = $1`, [acct.id]);
    expect(audit[0]!.payload.severity).toBe('critical');
    // Repair so later runs stay clean.
    await ownerQuery(`UPDATE positions SET qty = qty - 1000 WHERE account_id = $1 AND symbol = 'EURUSD'`, [acct.id]);
    await ownerQuery(`UPDATE accounts SET cash = cash - 1 WHERE id = $1`, [acct.id]);
    expect(await app.get(ReconciliationService).checkAccount(acct.id)).toEqual([]);
    // Only risk officers/admins run it across all accounts; novices cannot run it at all.
    const risk = await createUser(app, 'trader', ['risk_officer']);
    await request(http).get('/accounts/me').set(bearer(risk.token)).expect(200);
    await expect(ownerQuery(`UPDATE fills SET price = price WHERE account_id = $1`, [acct.id])).rejects.toThrow(/append-only/);
    const all = await request(http).post('/reconciliation/run').set(bearer(risk.token)).expect(200);
    expect(all.body.accountsChecked).toBeGreaterThan(1);
    const nov = await createUser(app, 'novice');
    await request(http).post('/reconciliation/run').set(bearer(nov.token)).expect(403);
  });

  it('the database refuses unbalanced journals and edits to fills or the ledger', async () => {
    const u = await createUser(app, 'trader');
    const acct = (await request(http).get('/accounts/me').set(bearer(u.token)).expect(200)).body;
    await expect(
      appQuery(
        `WITH j AS (INSERT INTO ledger_journals (account_id, kind, currency) VALUES ($1, 'adjustment', 'USD') RETURNING id)
         INSERT INTO ledger_entries (journal_id, account_id, ledger_account, amount) SELECT id, $1, 'cash', 5 FROM j`,
        [acct.id],
      ),
    ).rejects.toThrow(/unbalanced/);
    await expect(appQuery(`UPDATE ledger_entries SET amount = amount WHERE account_id = $1`, [acct.id])).rejects.toMatchObject({ code: '42501' });
    await expect(appQuery(`DELETE FROM ledger_entries WHERE account_id = $1`, [acct.id])).rejects.toMatchObject({ code: '42501' });
    await expect(appQuery(`DELETE FROM fills`)).rejects.toMatchObject({ code: '42501' });
    // Even the owner is stopped by the append-only trigger on fills (once rows exist).
    await ownerQuery('SELECT 1');
    const ledger = (await request(http).get('/accounts/me/ledger').set(bearer(u.token)).expect(200)).body;
    expect(ledger).toMatchObject({ trialBalance: '0', balances: { cash: '100000', capital: '-100000' } });
  });

  it('daily roll books overnight funding once per account per day (swap journal, audited)', async () => {
    await md.standard();
    const u = await createUser(app, 'trader');
    await buy(u, 'EURUSD', '100000');
    const acct = (await request(http).get('/accounts/me').set(bearer(u.token)).expect(200)).body;
    const engine = app.get(EngineLoopService);
    const rollTime = Date.parse('2026-09-30T21:30:00Z');
    await md.touch();
    const booked = await engine.rollover(rollTime);
    expect(booked).toBeGreaterThanOrEqual(1);
    expect(await engine.rollover(rollTime + 60_000)).toBe(0); // idempotent per roll date
    const swaps = await ownerQuery<{ amount: string }>(
      `SELECT e.amount::text AS amount FROM ledger_entries e JOIN ledger_journals j ON j.id = e.journal_id WHERE j.account_id = $1 AND j.kind = 'swap' AND e.ledger_account = 'cash'`,
      [acct.id],
    );
    // 100,000 × 1.0842 (mid) × −150 bps / 360 = −4.5175
    expect(swaps).toEqual([{ amount: '-4.5175' }]);
    const ev = await ownerQuery<{ payload: { symbol: string; amount: string } }>(`SELECT payload FROM audit_events WHERE action = 'position.swap_booked' AND payload->>'accountId' = $1`, [acct.id]);
    expect(ev[0]!.payload).toMatchObject({ symbol: 'EURUSD', amount: '-4.5175' });
    expect(await app.get(ReconciliationService).checkAccount(acct.id)).toEqual([]);
  });

  it('LIVE stays off: config refuses the flag, the stub broker refuses, and LIVE accounts need a sign-off', async () => {
    const stub = new LiveBrokerStub({ liveTradingEnabled: false, hasActiveSignoff: async () => true });
    await expect(stub.submit()).rejects.toBeInstanceOf(LiveTradingDisabledError);
    await expect(new LiveBrokerStub({ liveTradingEnabled: true, hasActiveSignoff: async () => false }).positions()).rejects.toThrow(/compliance sign-off/);
    await expect(new LiveBrokerStub({ liveTradingEnabled: true, hasActiveSignoff: async () => true }).cancel()).rejects.toThrow(/OQ-B1/);
    const u = await createUser(app, 'trader');
    await expect(ownerQuery(`UPDATE accounts SET environment = 'LIVE' WHERE user_id = $1`, [u.id])).resolves.toBeDefined(); // no account yet: no row
    await request(http).get('/accounts/me').set(bearer(u.token)).expect(200);
    await expect(ownerQuery(`UPDATE accounts SET environment = 'LIVE' WHERE user_id = $1`, [u.id])).rejects.toThrow(/compliance sign-off/);
    await expect(appQuery(`INSERT INTO compliance_signoffs (scope, signed_by, signer_role, document_ref) VALUES ('live_trading', 'x', 'x', 'x')`)).rejects.toMatchObject({ code: '42501' });
    const health = await request(http).get('/health').expect(200);
    expect(health.body).toMatchObject({ environment: 'PAPER', liveTradingEnabled: false });
  });
});
