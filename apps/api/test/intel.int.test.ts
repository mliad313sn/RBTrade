import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { RecordingProxy, validateExchanges } from './contract-proxy';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  fleschKincaidGrade,
  hasTradeSuggestion,
  ungroundedNumbers,
  withoutDisclaimer,
} from '../src/ai/core';
import { NEWS_FIXTURES, NewsScoreSchema } from '../src/intel/core';
import { NewsService } from '../src/intel/news.service';
import { ScanService } from '../src/intel/scan.service';
import { bearer, createUser, ownerQuery, startApp, type TestUser } from './helpers';
import { MarketFixture } from './market-fixture';
import { clearCandles, seedCandles, startQuant, type Bar, type Spawned } from './robot-helpers';

/**
 * Goal 07B acceptance through the real api (Postgres + Redis + the quant service): scan → features,
 * trends, forecasts and predictions logged before outcomes; "No reliable signal" by default and a
 * calibrated probability only from the seeded calibration table; news pipeline (dedup, entities,
 * schema-validated scores, injection attempts); explanations that cite stored article ids with
 * grounded numbers; the copilot's "what's trending" answer; draft to ticket; server-evaluated
 * alerts; the public reliability page. All data SIMULATED; the model is the scripted provider.
 */
const H = 3_600_000;
const N = 700;
const T0 = Math.floor(Date.now() / H) * H - N * H;

/** Deterministic random walk (xorshift) with an optional steady rise over the last bars. */
function series(seed: number, start: number, vol: number, riseBars = 0): Bar[] {
  let x = seed >>> 0 || 1;
  const rnd = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 1_000_000) / 1_000_000;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());
  const bars: Bar[] = [];
  let c = start;
  for (let i = 0; i < N; i++) {
    const o = c;
    const drift = i >= N - riseBars ? vol * 0.9 : 0;
    c = o * Math.exp(drift + vol * (riseBars && i >= N - riseBars ? 0.2 : 1) * gauss());
    const h = Math.max(o, c) * (1 + vol * 0.3 * rnd());
    const l = Math.min(o, c) * (1 - vol * 0.3 * rnd());
    bars.push({ t: T0 + i * H, o, h, l, c });
  }
  return bars;
}

const UNIVERSE: Array<[string, number, number, number]> = [
  ['7203.XTKS', 2800, 0.004, 60],
  ['0700.XHKG', 380, 0.005, 0],
  ['600519.XSHG', 1600, 0.004, 0],
  ['RELIANCE.XNSE', 2900, 0.004, 0],
  ['SAP.XETR', 190, 0.004, 0],
  ['HSBA.XLON', 7.2, 0.004, 0],
  ['NPN.XJSE', 3500, 0.005, 0],
  ['BHP.XASX', 45, 0.005, 0],
  ['AAPL', 190, 0.004, 0],
  ['PETR4.BVMF', 38, 0.005, 0],
  ['EURUSD', 1.08, 0.0012, 0],
];

const env = (vars: Record<string, string | undefined>) => {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

describe('Market intelligence (goal 07B)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let quant: Spawned;
  let proxy: RecordingProxy;
  let trader: TestUser;
  let novice: TestUser;
  let admin: TestUser;
  const md = new MarketFixture();

  beforeAll(async () => {
    quant = await startQuant();
    proxy = await new RecordingProxy(quant.url, 'api').start();
    env({
      QUANT_URL: proxy.url,
      KORA_AI_PROVIDER: 'scripted',
      KORA_AI_SCRIPT_PERSONA: 'reference',
      KORA_AI_RATE_PER_MIN: '1000',
      KORA_AI_ORG_ID: `org-intel-${process.pid}-${Date.now()}`,
      KORA_AI_REDIS_PREFIX: `kora:test:${process.pid}:intel:`,
      KORA_ENGINE_ENABLED: 'false',
      KORA_RECONCILIATION_INTERVAL_MS: '0',
      KORA_INTEL_SCAN: 'off',
      KORA_INTEL_NEWS: 'off',
      KORA_INTEL_BARS: String(N),
      KORA_INTEL_HORIZONS: '1d:24,1w:120',
    });
    app = await startApp();
    http = app.getHttpServer();
    await ownerQuery('DELETE FROM intel_alert_events');
    await ownerQuery('DELETE FROM intel_alerts');
    await ownerQuery('DELETE FROM intel_scans');
    await ownerQuery("DELETE FROM ai_predictions WHERE model_key LIKE 'trend:%'");
    await ownerQuery("DELETE FROM ai_calibration_bins WHERE model_key LIKE 'trend:%'");
    await ownerQuery('DELETE FROM news_scores');
    await ownerQuery('DELETE FROM news_entities');
    await ownerQuery('UPDATE news_articles SET dedup_of = NULL');
    await ownerQuery('DELETE FROM news_articles');
    // Only this file's SIMULATED 1h history is scanned.
    await ownerQuery("DELETE FROM md_candles_history WHERE tf = '1h'");
    await ownerQuery("DELETE FROM md_candles WHERE tf = '1h'");
    for (const [sym, start, vol, rise] of UNIVERSE) {
      await clearCandles(sym, '1h');
      await seedCandles(
        sym,
        '1h',
        series(sym.length * 7919 + Math.round(start), start, vol, rise),
        6,
      );
    }
    await md.status({ state: 'ok', feed: 'up', staleSymbols: [], ts: null });
    trader = await createUser(app, 'trader', [], { realClock: true });
    novice = await createUser(app, 'novice', [], { realClock: true });
    admin = await createUser(app, 'trader', ['admin', 'quant'], { realClock: true });
  }, 180_000);

  afterAll(async () => {
    await md.close();
    await app.close();
    await quant.stop();
    await proxy.stop();
    env({
      QUANT_URL: undefined,
      KORA_AI_PROVIDER: undefined,
      KORA_AI_SCRIPT_PERSONA: undefined,
      KORA_AI_RATE_PER_MIN: undefined,
      KORA_AI_ORG_ID: undefined,
      KORA_AI_REDIS_PREFIX: undefined,
      KORA_ENGINE_ENABLED: undefined,
      KORA_RECONCILIATION_INTERVAL_MS: undefined,
      KORA_INTEL_SCAN: undefined,
      KORA_INTEL_NEWS: undefined,
      KORA_INTEL_BARS: undefined,
      KORA_INTEL_HORIZONS: undefined,
      KORA_AI_MODEL: undefined,
    });
  });

  beforeEach(() => env({ KORA_AI_PROVIDER: 'scripted', KORA_AI_SCRIPT_PERSONA: 'reference' }));

  it('a scan stores features, trends and forecasts, audited, with the look-ahead guard passed', async () => {
    const res = await request(http).post('/intel/scan').set(bearer(admin.token)).expect(200);
    expect(res.body).toMatchObject({ instruments: UNIVERSE.length, guard: { passed: true } });
    expect(res.body.guard.checkpoints).toBeGreaterThanOrEqual(2);
    expect(res.body.forecasts).toBe(UNIVERSE.length * 2);
    const feats = await ownerQuery<{ symbol: string; features: Record<string, number | null> }>(
      "SELECT symbol, features FROM intel_features WHERE timeframe = '1h'",
    );
    expect(feats).toHaveLength(UNIVERSE.length);
    for (const f of feats) {
      expect(Object.keys(f.features)).toHaveLength(20);
      for (const v of Object.values(f.features))
        expect(v === null || typeof v === 'number').toBe(true);
    }
    const toyota = feats.find((f) => f.symbol === '7203.XTKS')!;
    expect(toyota.features.mom_z!).toBeGreaterThan(1.5);
    const audit = await ownerQuery<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM audit_events WHERE action = 'intel.scan' ORDER BY id DESC LIMIT 1",
    );
    expect(audit[0]!.payload).toMatchObject({ trigger: 'manual', simulated: true });
    // Novices cannot trigger scans.
    await request(http).post('/intel/scan').set(bearer(novice.token)).expect(403);
  }, 120_000);

  it('the radar filters by region and ranks emerging trends (features only)', async () => {
    const all = await request(http).get('/intel/radar').set(bearer(trader.token)).expect(200);
    expect(all.body.simulated).toBe(true);
    expect(all.body.heatMap.map((c: { key: string }) => c.key).sort()).toEqual([
      'africa',
      'americas',
      'asia',
      'europe',
      'global',
      'oceania',
    ]);
    const asia = await request(http)
      .get('/intel/radar?region=asia&assetClass=equity&window=week&groupBy=sector')
      .set(bearer(trader.token))
      .expect(200);
    expect(asia.body.instruments).toBe(4);
    expect(asia.body.trends.every((t: { region: string }) => t.region === 'asia')).toBe(true);
    const top = asia.body.trends.find((t: { symbol: string }) => t.symbol === '7203.XTKS');
    expect(top).toMatchObject({ kind: expect.stringMatching(/^(up|breakout_up)$/) });
    expect(asia.body.disclaimer).toBe('Not investment advice.');
  });

  it('forecasts are logged before their outcome is known; replayed OOS forecasts carry resolved outcomes', async () => {
    const live = await ownerQuery<{
      predicted_at: Date;
      outcome: boolean | null;
      resolved_at: Date | null;
      meta: Record<string, unknown>;
    }>(
      "SELECT predicted_at, outcome, resolved_at, meta FROM ai_predictions WHERE model_key = 'trend:logit:asia:1d' AND source = 'live'",
    );
    expect(live.length).toBe(4);
    for (const p of live) {
      expect(p.outcome).toBeNull();
      expect(p.resolved_at).toBeNull();
      expect(p.predicted_at.getTime()).toBeLessThanOrEqual(Date.now());
    }
    const replay = await ownerQuery<{ predicted_at: Date; resolved_at: Date; outcome: boolean }>(
      "SELECT predicted_at, resolved_at, outcome FROM ai_predictions WHERE model_key = 'trend:logit:asia:1d' AND source = 'history_replay'",
    );
    expect(replay.length).toBeGreaterThan(20);
    for (const p of replay)
      expect(p.resolved_at.getTime() - p.predicted_at.getTime()).toBeGreaterThanOrEqual(24 * H);
    // A live forecast whose horizon has passed is resolved from later candles.
    const at = T0 + 600 * H;
    await ownerQuery(
      `INSERT INTO ai_predictions (model_key, subject, horizon, predicted, source, predicted_at, meta)
       VALUES ('trend:logit:asia:1d', 'TEST:1d', '1d', 0.6, 'live', $1, $2)`,
      [
        new Date(at).toISOString(),
        JSON.stringify({
          symbol: '0700.XHKG',
          timeframe: '1h',
          horizonBars: 24,
          entryClose: 380,
          cost: 0.001,
          direction: 'up',
        }),
      ],
    );
    const n = await app.get(ScanService).resolveDue();
    expect(n).toBeGreaterThanOrEqual(1);
    const r = await ownerQuery<{ outcome: boolean; resolved_at: Date; net_return: number }>(
      "SELECT outcome, resolved_at, net_return FROM ai_predictions WHERE subject = 'TEST:1d'",
    );
    expect(r[0]!.outcome).not.toBeNull();
    expect(r[0]!.resolved_at.getTime()).toBe(at + 24 * H);
    expect(Number.isFinite(r[0]!.net_return)).toBe(true);
    await ownerQuery("DELETE FROM ai_predictions WHERE subject = 'TEST:1d'");
  });

  it('the news pipeline dedups, links entities, translates and stores schema-valid scores only', async () => {
    const res = await request(http)
      .post('/intel/news/ingest')
      .set(bearer(admin.token))
      .send({ adapter: 'simulated' })
      .expect(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      fetched: NEWS_FIXTURES.length,
      inserted: NEWS_FIXTURES.length,
      duplicates: 2,
      invalid: 0,
    });
    expect(res.body.scored).toBe(NEWS_FIXTURES.length - 2);
    expect(Object.keys(res.body.languages).sort()).toEqual([
      'ar',
      'de',
      'en',
      'es',
      'fr',
      'ja',
      'pt',
      'zh',
    ]);
    const again = await request(http)
      .post('/intel/news/ingest')
      .set(bearer(admin.token))
      .send({})
      .expect(200);
    expect(again.body.inserted).toBe(0);
    const dups = await ownerQuery<{ external_id: string; dedup_of: string | null }>(
      'SELECT external_id, dedup_of FROM news_articles WHERE dedup_of IS NOT NULL ORDER BY external_id',
    );
    expect(dups.map((d) => d.external_id)).toEqual(['amer-0006', 'apac-0003']);
    const scores = await ownerQuery<Record<string, unknown>>('SELECT * FROM news_scores');
    expect(scores).toHaveLength(NEWS_FIXTURES.length - 2);
    for (const s of scores) {
      expect(s.status).toBe('ok');
      expect(s.model_id).toBe('scripted:reference');
      expect(String(s.prompt_hash)).toMatch(/^[0-9a-f]{64}$/);
      const ok = NewsScoreSchema.omit({ entities: true }).safeParse({
        sentiment: s.sentiment,
        relevance: s.relevance,
        novelty: s.novelty,
        eventType: s.event_type,
      });
      expect(ok.success).toBe(true);
    }
    const ja = await ownerQuery<{ detected_language: string; translated_title: string }>(
      "SELECT s.detected_language, s.translated_title FROM news_scores s JOIN news_articles a ON a.id = s.article_id WHERE a.external_id = 'apac-0002'",
    );
    expect(ja[0]).toMatchObject({
      detected_language: 'ja',
      translated_title: expect.stringMatching(/^Toyota raises/),
    });
    const toyota = await ownerQuery<{ ref: string }>(
      "SELECT e.ref FROM news_entities e JOIN news_articles a ON a.id = e.article_id WHERE a.external_id = 'apac-0002' AND e.kind = 'symbol'",
    );
    expect(toyota.map((t) => t.ref)).toEqual(['7203.XTKS']);
    const audits = await ownerQuery<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_events WHERE action = 'ai.request' AND payload->>'surface' = 'news' AND payload->>'modelId' = 'scripted:reference'",
    );
    expect(audits[0]!.n).toBe(NEWS_FIXTURES.length - 2);
  });

  it('prompt-injection articles cannot change entities, leak canaries or break out of the wrapper', async () => {
    const injected = NEWS_FIXTURES.filter((f) => f.injection);
    expect(injected.length).toBeGreaterThanOrEqual(8);
    for (const f of injected) {
      const rows = await ownerQuery<{
        id: string;
        translated_title: string | null;
        translated_summary: string | null;
        errors: unknown;
        sentiment: number;
      }>(
        `SELECT a.id, s.translated_title, s.translated_summary, s.errors, s.sentiment FROM news_articles a
           JOIN news_scores s ON s.article_id = a.id WHERE a.external_id = $1`,
        [f.externalId],
      );
      const blob = JSON.stringify(rows[0]);
      expect(blob).not.toContain(f.canary!);
      expect(rows[0]!.sentiment).toBe(0); // the instructions to set sentiment to 1 were ignored
    }
    // Entity links come from the dictionary match of the text, never from the model's answer.
    const pe = await ownerQuery<{ n: number }>(
      "SELECT count(*)::int AS n FROM news_entities e JOIN news_articles a ON a.id = e.article_id WHERE a.external_id = 'inj-0007' AND e.ref = 'PETR4.BVMF'",
    );
    expect(pe[0]!.n).toBe(0);
    // A compromised model's output is rejected by the schema and never stored as a score.
    env({ KORA_AI_SCRIPT_PERSONA: 'adversarial' });
    const news = app.get(NewsService);
    const art = await ownerQuery<{ id: string; title: string; body: string }>(
      "SELECT id, title, body FROM news_articles WHERE external_id = 'inj-0001'",
    );
    const status = await news.score(
      art[0]!.id,
      art[0]!.title,
      art[0]!.body,
      'en',
      ['NVDA'],
      new Date(),
    );
    expect(status).toBe('invalid');
    const s = await ownerQuery<{ status: string; sentiment: number | null; errors: string[] }>(
      'SELECT status, sentiment, errors FROM news_scores WHERE article_id = $1',
      [art[0]!.id],
    );
    expect(s[0]).toMatchObject({ status: 'invalid', sentiment: null });
    expect(s[0]!.errors.join(' ')).toMatch(/sentiment|Unrecognized/);
    // Restore the reference score for later tests.
    env({ KORA_AI_SCRIPT_PERSONA: 'reference' });
    expect(
      await news.score(art[0]!.id, art[0]!.title, art[0]!.body, 'en', ['NVDA'], new Date()),
    ).toBe('ok');
    // No model configured → unavailable (no invented scores); licensed providers are flagged stubs.
    env({ KORA_AI_PROVIDER: 'anthropic', KORA_AI_MODEL: undefined });
    expect(
      await news.score(art[0]!.id, art[0]!.title, art[0]!.body, 'en', ['NVDA'], new Date()),
    ).toBe('unavailable');
    env({ KORA_AI_PROVIDER: 'scripted' });
    await news.score(art[0]!.id, art[0]!.title, art[0]!.body, 'en', ['NVDA'], new Date());
    const stub = await request(http)
      .post('/intel/news/ingest')
      .set(bearer(admin.token))
      .send({ adapter: 'newswire-apac' })
      .expect(200);
    expect(stub.body).toMatchObject({
      status: 'unavailable',
      message: expect.stringMatching(/KORA_NEWS_ADAPTER_APAC/),
    });
  });

  it('shows "No reliable signal" by default and a calibrated probability only from the seeded table', async () => {
    const card = await request(http)
      .get('/intel/trends/7203.XTKS?horizon=1d')
      .set(bearer(trader.token))
      .expect(200);
    expect(card.body.modelKey).toBe('trend:logit:asia:1d');
    expect(card.body.probability).toMatchObject({
      status: 'no_reliable_signal',
      label: 'No reliable signal',
    });
    expect(card.body.drivers.length).toBeGreaterThan(0);
    expect(card.body.news.map((n: { id: string }) => n.id).length).toBeGreaterThan(0);
    expect(card.body.invalidation?.rule).toMatch(/would invalidate this view/);
    const week = await request(http)
      .get('/intel/trends/7203.XTKS?horizon=1w')
      .set(bearer(trader.token))
      .expect(200);
    expect(week.body.probability.reason).toMatch(/Not enough SIMULATED history/);

    // Seeded calibration table: an edge after costs and n=212 in every upper bin.
    await ownerQuery("DELETE FROM ai_calibration_bins WHERE model_key = 'trend:logit:asia:1d'");
    for (let b = 0; b < 10; b++)
      await ownerQuery(
        `INSERT INTO ai_calibration_bins (model_key, bin, lo, hi, n, hits, mean_predicted, mean_net_return, net_return_sd, source)
         VALUES ('trend:logit:asia:1d', $1, $2, $3, $4, $5, $6, 0.002, 0.01, 'seed')`,
        [
          b,
          (b / 10).toFixed(2),
          ((b + 1) / 10).toFixed(2),
          b >= 5 ? 212 : 0,
          b >= 5 ? 121 : 0,
          b >= 5 ? (b + 0.5) / 10 : null,
        ],
      );
    const seeded = await request(http)
      .get('/intel/trends/7203.XTKS?horizon=1d')
      .set(bearer(trader.token))
      .expect(200);
    expect(seeded.body.probability).toMatchObject({ status: 'calibrated', value: 0.57, n: 212 });
    expect(seeded.body.probability.reliabilityLine).toMatch(
      /^When we said 0\.\d+, it happened 57% of the time \(n=212\)$/,
    );
    // Too few forecasts in the bin → no number at all.
    await ownerQuery(
      "UPDATE ai_calibration_bins SET n = 5, hits = 3 WHERE model_key = 'trend:logit:asia:1d'",
    );
    const small = await request(http)
      .get('/intel/trends/7203.XTKS?horizon=1d')
      .set(bearer(trader.token))
      .expect(200);
    expect(small.body.probability.status).toBe('no_reliable_signal');
  });

  it('explanations cite stored article ids and every number matches the card (pro) / grade ≤ 8 (novice)', async () => {
    const res = await request(http)
      .post('/intel/trends/7203.XTKS/explain')
      .set(bearer(trader.token))
      .send({ horizon: '1d' })
      .expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.flags.ungrounded).toEqual([]);
    const cited = [...String(res.body.answer).matchAll(/\[news:([0-9a-f-]{36})\]/g)].map(
      (m) => m[1],
    );
    expect(cited.length).toBeGreaterThan(0);
    const stored = await ownerQuery<{ id: string }>(
      'SELECT id FROM news_articles WHERE id = ANY($1)',
      [cited],
    );
    expect(stored).toHaveLength(new Set(cited).size);
    expect(ungroundedNumbers(withoutDisclaimer(res.body.answer), [res.body.card], 'exact')).toEqual(
      [],
    );
    expect(res.body.answer).toMatch(/Not investment advice\.$/);
    const audit = await ownerQuery<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM audit_events WHERE action = 'ai.request' AND actor_id = $1 ORDER BY id DESC LIMIT 1",
      [trader.id],
    );
    expect(audit[0]!.payload).toMatchObject({
      surface: 'radar',
      status: 'ok',
      modelId: 'scripted:reference',
    });
    const nov = await request(http)
      .post('/intel/trends/7203.XTKS/explain')
      .set(bearer(novice.token))
      .send({ horizon: '1d', mode: 'pro' })
      .expect(200);
    expect(nov.body.status).toBe('ok');
    expect(nov.body.flags.fallback).toBe(false);
    const text = withoutDisclaimer(nov.body.answer);
    expect(fleschKincaidGrade(text)).toBeLessThanOrEqual(8);
    expect(hasTradeSuggestion(text)).toBe(false);
  });

  it('the copilot answers "What is trending in Asian equities this week and why?" from radar and news tools', async () => {
    const res = await request(http)
      .post('/ai/chat')
      .set(bearer(trader.token))
      .send({ message: "What's trending in Asian equities this week and why?" })
      .expect(200);
    expect(res.body.status).toBe('ok');
    const tools = res.body.toolCalls.map(
      (t: { name: string; outcome: string }) => `${t.name}:${t.outcome}`,
    );
    expect(tools[0]).toBe('get_market_radar:ok');
    expect(tools.filter((t: string) => t === 'get_news:ok').length).toBeGreaterThan(0);
    expect(res.body.answer).toContain('7203.XTKS');
    expect(res.body.answer).toMatch(/\[news:[0-9a-f-]{36}\]/);
    expect(res.body.flags.ungrounded).toEqual([]);
    const nov = await request(http)
      .post('/ai/chat')
      .set(bearer(novice.token))
      .send({ message: "What's trending in Asian equities this week?" })
      .expect(200);
    expect(nov.body.status).toBe('ok');
    expect(hasTradeSuggestion(nov.body.answer)).toBe(false);
  });

  it('draft to ticket creates an audited draft only; placing still needs preview and confirmation', async () => {
    await md.quote('7203.XTKS', '3000.0', '3000.5');
    const before = await ownerQuery<{ n: number }>(
      'SELECT count(*)::int AS n FROM orders o JOIN accounts a ON a.id = o.account_id WHERE a.user_id = $1',
      [trader.id],
    );
    const d = await request(http)
      .post('/intel/trends/7203.XTKS/draft')
      .set(bearer(trader.token))
      .send({ horizon: '1d' })
      .expect(200);
    expect(d.body).toMatchObject({
      status: 'draft',
      prefill: { symbol: '7203.XTKS', side: 'buy', origin: 'ai', aiDraftId: d.body.draftId },
    });
    const after = await ownerQuery<{ n: number }>(
      'SELECT count(*)::int AS n FROM orders o JOIN accounts a ON a.id = o.account_id WHERE a.user_id = $1',
      [trader.id],
    );
    expect(after[0]!.n).toBe(before[0]!.n);
    const draft = await ownerQuery<{ surface: string; status: string }>(
      'SELECT surface, status FROM ai_order_drafts WHERE id = $1',
      [d.body.draftId],
    );
    expect(draft[0]).toEqual({ surface: 'radar', status: 'draft' });
    await request(http)
      .post('/intel/trends/7203.XTKS/draft')
      .set(bearer(novice.token))
      .send({})
      .expect(403);
  });

  it('alerts are evaluated by the server after a scan', async () => {
    const a = await request(http)
      .post('/intel/alerts')
      .set(bearer(trader.token))
      .send({
        name: 'Asia uptrends',
        rule: { trendKinds: ['up', 'breakout_up'], region: 'asia', minScore: 0 },
      })
      .expect(201);
    expect(a.body.active).toBe(true);
    await app.get(ScanService).run('test');
    const list = await request(http).get('/intel/alerts').set(bearer(trader.token)).expect(200);
    expect(list.body.evaluatedBy).toBe('server');
    expect(list.body.events.some((e: { symbol: string }) => e.symbol === '7203.XTKS')).toBe(true);
    await request(http).get('/intel/alerts').set(bearer(novice.token)).expect(403);
    await request(http).delete(`/intel/alerts/${a.body.id}`).set(bearer(trader.token)).expect(200);
  }, 120_000);

  it('the reliability page is public and computed from stored predictions; providers are flagged stubs', async () => {
    const res = await request(http).get('/intel/reliability').expect(200);
    const asia = res.body.models.find(
      (m: { modelKey: string }) => m.modelKey === 'trend:logit:asia:1d',
    );
    expect(asia).toMatchObject({ model: 'logit', region: 'asia', horizon: '1d' });
    expect(asia.live.forecasts).toBeGreaterThanOrEqual(4);
    expect(asia.replay.resolved).toBeGreaterThan(20);
    const prov = await request(http).get('/intel/providers').set(bearer(novice.token)).expect(200);
    expect(
      prov.body.matrix.every(
        (p: { flagged: boolean; licensed: boolean }) => p.flagged && !p.licensed,
      ),
    ).toBe(true);
    expect(prov.body.news.every((p: { licensed: boolean }) => !p.licensed)).toBe(true);
  });

  it("the novice What's moving card is plain words with no suggestion", async () => {
    const res = await request(http)
      .get('/intel/whats-moving')
      .set(bearer(novice.token))
      .expect(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const it of res.body.items) {
      expect(fleschKincaidGrade(it.headline)).toBeLessThanOrEqual(8);
      expect(hasTradeSuggestion(`${it.headline} ${it.why ?? ''}`)).toBe(false);
    }
    expect(res.body.disclaimer).toBe('Not investment advice.');
  });
  it('contract (goal 10): every api → quant exchange matches the quant OpenAPI', async () => {
    const doc = (await (await fetch(`${quant.url}/openapi.json`)).json()) as Parameters<typeof validateExchanges>[0];
    const traffic = proxy.exchanges.filter((x) => x.path !== '/health');
    expect(traffic.length).toBeGreaterThan(0);
    expect([...new Set(traffic.map((x) => x.path))]).toEqual(expect.arrayContaining(['/scanner/run']));
    expect(validateExchanges(doc, 'quant', traffic)).toEqual([]);
  });
});
