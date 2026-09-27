import type { INestApplication } from '@nestjs/common';
import { SEED_ALIASES, SEED_ASSET_CLASSES, SEED_INSTRUMENTS, SEED_VENUES } from '@kora/market-data';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { InstrumentsRepository } from '../src/market-data/instruments.repository';
import { appQuery, bearer, createUser, ownerQuery, startApp } from './helpers';

describe('instrument registry (goal 02, global)', () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    app = await startApp();
    token = (await createUser(app, 'novice')).token;
  });
  afterAll(async () => app.close());

  it('database registry equals the SIMULATED seed catalog (no drift)', async () => {
    const reg = await app.get(InstrumentsRepository).load(0);
    expect([...reg.instruments.values()]).toEqual(
      [...SEED_INSTRUMENTS].sort((a, b) => (a.symbol < b.symbol ? -1 : 1)),
    );
    expect([...reg.venues.values()]).toEqual(
      [...SEED_VENUES].sort((a, b) => (a.mic < b.mic ? -1 : 1)),
    );
    expect(Object.fromEntries(reg.staleAfterMs)).toEqual(
      Object.fromEntries(SEED_ASSET_CLASSES.map((a) => [a.assetClass, a.staleAfterMs])),
    );
    expect(reg.aliases.length).toBe(SEED_ALIASES.length);
  });

  it('GET /instruments filters by class, venue, region and search; carries session + label', async () => {
    const http = app.getHttpServer();
    const all = await request(http).get('/instruments').set(bearer(token)).expect(200);
    expect(all.body.instruments.length).toBe(SEED_INSTRUMENTS.length);
    const us500 = all.body.instruments.find((i: { symbol: string }) => i.symbol === 'US500');
    expect(us500).toMatchObject({
      assetClass: 'cfd',
      underlyingClass: 'index',
      assetClassLabel: 'Index CFD',
      tickSize: '0.1',
      pricePrecision: 1,
    });
    expect(us500.session).toMatchObject({ source: 'instrument', timezone: 'America/Chicago' });
    const asia = await request(http).get('/instruments?region=asia').set(bearer(token)).expect(200);
    expect(
      asia.body.instruments
        .map((i: { venue: string }) => i.venue)
        .every((v: string) => ['XTKS', 'XHKG', 'XSHG', 'XNSE'].includes(v)),
    ).toBe(true);
    const fx = await request(http)
      .get('/instruments?assetClass=fx&q=jpy')
      .set(bearer(token))
      .expect(200);
    expect(fx.body.instruments.map((i: { symbol: string }) => i.symbol)).toEqual([
      'EURJPY',
      'GBPJPY',
      'USDJPY',
    ]);
    await request(http).get('/instruments?assetClass=stocks').set(bearer(token)).expect(400);
    await request(http).get('/instruments').expect(401);
  });

  it('GET /instruments/:symbol and /venues expose venue timezone sessions', async () => {
    const http = app.getHttpServer();
    const t = await request(http).get('/instruments/7203.XTKS').set(bearer(token)).expect(200);
    expect(t.body).toMatchObject({
      isin: 'JP3633400001',
      venue: 'XTKS',
      staleAfterMs: 5000,
      venueInfo: { timezone: 'Asia/Tokyo', region: 'asia' },
    });
    expect(['open', 'break', 'closed', 'holiday']).toContain(t.body.session.state);
    await request(http).get('/instruments/NOPE').set(bearer(token)).expect(404);
    const v = await request(http).get('/venues').set(bearer(token)).expect(200);
    expect(new Set(v.body.venues.map((x: { region: string }) => x.region))).toEqual(
      new Set(['africa', 'asia', 'europe', 'north_america', 'south_america', 'oceania', 'global']),
    );
    const kcry = await request(http).get('/venues/KCRY').set(bearer(token)).expect(200);
    expect(kcry.body).toMatchObject({
      isoMic: false,
      session: { state: 'open', nextChange: null },
    });
    await request(http).get('/venues/xx').set(bearer(token)).expect(404);
  });

  it('the database enforces registry invariants and the runtime role cannot edit reference data', async () => {
    const base = `INSERT INTO instruments (symbol, display_name, venue, asset_class, quote_ccy, tick_size, price_precision, contract_size, min_qty, qty_step, qty_precision, fee_schedule_id)`;
    await expect(
      ownerQuery(
        `${base} VALUES ('BAD1', 'x', 'XNYS', 'equity', 'USD', 0.001, 2, 1, 1, 1, 0, 'f')`,
      ),
    ).rejects.toThrow(/instruments_tick_fits_precision/);
    await expect(
      ownerQuery(
        `${base} VALUES ('BAD2', 'x', 'XNYS', 'equity', 'USD', 0.01, 2, 1, 0.5, 1, 0, 'f')`,
      ),
    ).rejects.toThrow(/instruments_min_on_step/);
    await expect(
      ownerQuery(`UPDATE venues SET timezone = 'Mars/Olympus' WHERE mic = 'XNYS'`),
    ).rejects.toThrow(/unknown IANA timezone/);
    await expect(
      ownerQuery(`UPDATE instruments SET isin = 'BAD' WHERE symbol = 'AAPL'`),
    ).rejects.toThrow(/check constraint/);
    await expect(
      appQuery(`${base} VALUES ('BAD3', 'x', 'XNYS', 'equity', 'USD', 0.01, 2, 1, 1, 1, 0, 'f')`),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      appQuery(`UPDATE instruments SET tick_size = 1 WHERE symbol = 'EURUSD'`),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('serves a SIMULATED economic calendar', async () => {
    const res = await request(app.getHttpServer())
      .get('/calendar?from=2026-09-21T00:00:00Z&to=2026-09-26T00:00:00Z')
      .set(bearer(token))
      .expect(200);
    expect(res.body).toMatchObject({ source: 'simulated', simulated: true });
    expect(res.body.events.length).toBeGreaterThanOrEqual(15);
    expect(res.body.events[0]).toEqual(
      expect.objectContaining({
        country: expect.any(String),
        impact: expect.any(Number),
        title: expect.any(String),
      }),
    );
  });
});
