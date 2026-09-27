// Goal 10 (S10): metrics, dashboards and alert rules fit together.
// - the api exports the operational metrics (HTTP, orders, rejections, fills/slippage, kill switch,
//   robots, feed, governance) after a real trading flow;
// - every Prometheus alert has a severity, an SLO or owner label and a runbook link to a file that
//   exists in docs/runbooks (goal 09);
// - every metric used by an alert rule or a Grafana panel is exported by the api.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { EngineLoopService } from '../src/trading/engine-loop.service';
import { bearer, createUser, startApp, type TestUser } from './helpers';
import { MARKET_OPEN_UTC, MarketFixture } from './market-fixture';

const ROOT = resolve(__dirname, '../../..');
const RULES = join(ROOT, 'infra/prometheus/alerts.yml');
const DASHBOARDS = join(ROOT, 'infra/grafana/provisioning/dashboards');

interface Rule {
  alert: string;
  expr: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

function metricNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(/\bkora_[a-z0-9_]+/g)) names.add(m[0].replace(/_(bucket|sum|count)$/, ''));
  return names;
}

function dashboardExprs(): Array<{ file: string; expr: string }> {
  const out: Array<{ file: string; expr: string }> = [];
  for (const f of readdirSync(DASHBOARDS).filter((x) => x.endsWith('.json'))) {
    const d = JSON.parse(readFileSync(join(DASHBOARDS, f), 'utf8')) as { panels: Array<{ targets?: Array<{ expr: string }> }> };
    for (const p of d.panels) for (const t of p.targets ?? []) out.push({ file: f, expr: t.expr });
  }
  return out;
}

describe('observability: metrics, dashboards and alert rules (goal 10)', () => {
  let app: INestApplication;
  let trader: TestUser;
  let scrape = '';
  const md = new MarketFixture();

  beforeAll(async () => {
    process.env.KORA_ENGINE_ENABLED = 'false';
    process.env.KORA_RECONCILIATION_INTERVAL_MS = '0';
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(MARKET_OPEN_UTC);
    app = await startApp();
    await md.standard();
    trader = await createUser(app, 'trader');
    const http = app.getHttpServer();
    const t = bearer(trader.token);
    await md.touch();
    await request(http).post('/orders').set(t).send({ clientOrderId: `obs-${process.pid}-1`, symbol: 'EURUSD', side: 'buy', type: 'market', qty: '10000' }).expect(201);
    await app.get(EngineLoopService).matchSymbol('EURUSD');
    await md.touch();
    // a risk rejection (fat finger)
    await request(http).post('/orders').set(t).send({ clientOrderId: `obs-${process.pid}-2`, symbol: 'EURUSD', side: 'buy', type: 'limit', qty: '10000', limitPrice: '1.00000' }).expect(422);
    await request(http).post('/kill-switch').set(t).send({ scope: 'robots_cancel', source: 'rest_fallback', reason: 'observability test' }).expect(202);
    await request(http).post('/kill-switch/resume').set(t).send({ reason: 'observability test done' }).expect(200);
    scrape = (await request(http).get('/metrics').expect(200)).text;
  }, 120_000);

  afterAll(async () => {
    await md.close();
    await app?.close();
    vi.useRealTimers();
    delete process.env.KORA_ENGINE_ENABLED;
    delete process.env.KORA_RECONCILIATION_INTERVAL_MS;
  });

  it('exports the order path, fills, kill switch, HTTP and governance metrics with real samples', () => {
    expect(scrape).toMatch(/kora_order_submit_seconds_count\{outcome="accepted",source="manual"\} [1-9]/);
    expect(scrape).toMatch(/kora_order_submit_seconds_count\{outcome="rejected",source="manual"\} [1-9]/);
    expect(scrape).toMatch(/kora_order_rejections_total\{code="FAT_FINGER"\} [1-9]/);
    expect(scrape).toMatch(/kora_fills_total\{liquidity="taker"\} [1-9]/);
    expect(scrape).toMatch(/kora_fill_slippage_bps_count\{symbol="EURUSD"\} [1-9]/);
    expect(scrape).toMatch(/kora_kill_switch_activations_total\{scope="robots_cancel",kind="account"\} 1/);
    expect(scrape).toMatch(/kora_kill_switch_duration_seconds_count\{scope="robots_cancel"\} 1/);
    expect(scrape).toMatch(/kora_http_requests_total\{method="POST",route="\/orders",status="2xx"\} [1-9]/);
    expect(scrape).toMatch(/kora_http_requests_total\{method="POST",route="\/orders",status="4xx"\} [1-9]/);
    // the scrape-time governance reader ran its query
    expect(scrape).toMatch(/kora_governance\{metric="four_eyes_pending"\} \d+/);
    expect(scrape).toMatch(/kora_governance\{metric="alerts_open_critical"\} \d+/);
    // the copilot metrics (goal 07) are still in the same scrape
    expect(scrape).toContain('# HELP kora_ai_requests_total');
    // raw URLs never become labels
    expect(scrape).not.toMatch(/route="\/orders\/[0-9a-f-]{36}"/);
  });

  it('every alert rule has a severity, a runbook that exists, and only uses exported metrics', () => {
    const doc = parse(readFileSync(RULES, 'utf8')) as { groups: Array<{ rules: Rule[] }> };
    const rules = doc.groups.flatMap((g) => g.rules);
    expect(rules.length).toBeGreaterThanOrEqual(15);
    const exported = metricNames(scrape);
    const problems: string[] = [];
    for (const r of rules) {
      if (!r.labels?.severity) problems.push(`${r.alert}: no severity`);
      const url = r.annotations?.runbook_url ?? '';
      const m = /\/blob\/main\/(docs\/runbooks\/[a-z0-9-]+\.md)$/.exec(url);
      if (!m) problems.push(`${r.alert}: runbook_url is not a docs/runbooks link (${url})`);
      else if (!existsSync(join(ROOT, m[1]!))) problems.push(`${r.alert}: runbook ${m[1]} does not exist`);
      if (!r.annotations?.summary) problems.push(`${r.alert}: no summary`);
      for (const name of metricNames(r.expr)) if (!exported.has(name)) problems.push(`${r.alert}: metric ${name} is not exported`);
    }
    expect(problems).toEqual([]);
    // every runbook scenario of goal 09 is reachable from at least one alert
    const linked = new Set(rules.map((r) => /docs\/runbooks\/([a-z0-9-]+)\.md/.exec(r.annotations?.runbook_url ?? '')?.[1]));
    for (const rb of ['feed-outage', 'engine-stall', 'reconciliation-break', 'ai-provider-outage', 'kill-switch-fired', 'database-restore', 'incident-workflow']) {
      expect(linked, `no alert links to ${rb}`).toContain(rb);
    }
  });

  it('every Grafana panel query uses exported metrics; the goal 10 dashboards cover the listed areas', () => {
    const exported = metricNames(scrape);
    const exprs = dashboardExprs();
    const missing = exprs.flatMap(({ file, expr }) => [...metricNames(expr)].filter((n) => !exported.has(n)).map((n) => `${file}: ${n}`));
    expect(missing).toEqual([]);
    const all = exprs.map((e) => e.expr).join('\n');
    for (const area of [
      'kora_feed_up', // feed health
      'kora_order_submit_seconds_bucket', // order latency
      'kora_order_rejections_total', // rejection reasons
      'kora_fill_slippage_bps_bucket', // fills / slippage
      'kora_robot_heartbeat_max_age_seconds', // bot heartbeats
      'kora_ai_tokens_total', // AI tokens
      'kora_ai_cost_usd_total', // AI cost
      '/ 0.001', // error budget
    ]) {
      expect(all, area).toContain(area);
    }
  });
});
