// Goal 10 (S10): api ↔ quant contract for the gain simulator. `sim.int.test.ts` checks the api's
// behaviour against a stub; this file runs the real quant service behind a recording proxy and
// validates every exchange against quant's own OpenAPI document (requests and responses).
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RecordingProxy, validateExchanges } from './contract-proxy';
import { bearer, createUser, startApp, type TestUser } from './helpers';
import { startQuant, type Spawned } from './robot-helpers';

describe('api ↔ quant contract (gain simulator)', () => {
  let app: INestApplication;
  let quant: Spawned;
  let proxy: RecordingProxy;
  let trader: TestUser;

  beforeAll(async () => {
    quant = await startQuant();
    proxy = await new RecordingProxy(quant.url, 'api').start();
    process.env.QUANT_URL = proxy.url;
    app = await startApp();
    trader = await createUser(app, 'trader', [], { realClock: true });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await proxy?.stop();
    await quant?.stop();
    delete process.env.QUANT_URL;
  });

  it('every simulator exchange matches the quant OpenAPI, including edge cases', async () => {
    const http = app.getHttpServer();
    const t = bearer(trader.token);
    await request(http).post('/sim/project').set(t).send({ paths: 1000 }).expect(200);
    await request(http)
      .post('/sim/project')
      .set(t)
      .send({
        paths: 1000,
        winRatePct: 45,
        avgWinR: 1.8,
        stressEdgeCutPct: 50,
        sizingModel: 'kelly_fraction',
      })
      .expect(200);
    await request(http)
      .post('/sim/from-trades')
      .set(t)
      .send({ trades: [1.8, -1, -1, 2.1, 0.4, -0.6], source: 'backtest_in_sample', paths: 500 })
      .expect(200);
    // no losing trade: full Kelly is unbounded (the contract finding fixed in goal 10)
    const allWins = await request(http)
      .post('/sim/from-trades')
      .set(t)
      .send({ trades: [1, 2, 0.5, 1.5], paths: 500 })
      .expect(200);
    expect(allWins.body.kelly.full).toBeNull();
    await request(http).get('/sim/paper/analytics').set(t).expect(200);
    await request(http)
      .post('/sim/paper/project')
      .set(t)
      .send({ horizonPeriods: 12, paths: 1000 })
      .expect(200);

    const doc = (await (await fetch(`${quant.url}/openapi.json`)).json()) as Parameters<
      typeof validateExchanges
    >[0];
    const traffic = proxy.exchanges.filter((x) => x.path !== '/health');
    expect([...new Set(traffic.map((x) => x.path))].sort()).toEqual([
      '/analytics/paper',
      '/mc/from-trades',
      '/mc/project',
    ]);
    expect(validateExchanges(doc, 'quant', traffic)).toEqual([]);
  });
});
