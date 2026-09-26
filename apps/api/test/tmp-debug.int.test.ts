import request from 'supertest';
import { it, vi } from 'vitest';
import { bearer, createUser, startApp } from './helpers';
import { MARKET_OPEN_UTC, MarketFixture } from './market-fixture';
it('debug', async () => {
  process.env.KORA_ENGINE_ENABLED = 'false';
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(MARKET_OPEN_UTC);
  const app = await startApp();
  const md = new MarketFixture(); await md.standard();
  const u = await createUser(app, 'trader');
  const body = { clientOrderId: 'dbg-1', symbol: 'EURUSD', side: 'buy', type: 'limit', qty: '10000', limitPrice: '1.08000' };
  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: 50 }, () => request(app.getHttpServer()).post('/orders').set(bearer(u.token)).send(body)));
  console.log('ms', Date.now() - t0, JSON.stringify(results.map((r) => [r.status, r.body.error ?? r.body.message ?? ''])).slice(0, 1500));
  await md.close(); await app.close();
}, 60000);
