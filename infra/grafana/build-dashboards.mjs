#!/usr/bin/env node
// Generates the KORA Grafana dashboards (goal 10, B-012/B-916) into provisioning/dashboards/.
// Run: node infra/grafana/build-dashboards.mjs. The api test checks that every query uses metrics
// the api actually exports. ai-copilot.json (goal 07) is maintained by hand.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'provisioning/dashboards');
const DS = { type: 'prometheus', uid: 'prometheus' };

function dashboard(uid, title, description, rows) {
  let id = 1;
  let y = 0;
  const panels = [];
  for (const row of rows) {
    panels.push({ id: id++, type: 'row', title: row.title, collapsed: false, gridPos: { x: 0, y: y++, w: 24, h: 1 }, panels: [] });
    let x = 0;
    for (const p of row.panels) {
      const w = p.w ?? 8;
      const h = p.h ?? 7;
      if (x + w > 24) {
        x = 0;
        y += h;
      }
      panels.push({
        id: id++,
        type: p.type ?? 'timeseries',
        title: p.title,
        description: p.description ?? '',
        datasource: DS,
        gridPos: { x, y, w, h },
        fieldConfig: { defaults: { unit: p.unit ?? 'short', ...(p.thresholds ? { thresholds: { mode: 'absolute', steps: p.thresholds } } : {}) }, overrides: [] },
        options: p.type === 'stat' ? { reduceOptions: { calcs: ['lastNotNull'] }, colorMode: 'value' } : { legend: { displayMode: 'list', placement: 'bottom' } },
        targets: p.targets.map((t, i) => ({ refId: String.fromCharCode(65 + i), expr: t.expr, legendFormat: t.legend ?? '', datasource: DS })),
      });
      x += w;
    }
    y += Math.max(...row.panels.map((p) => p.h ?? 7));
  }
  return {
    title,
    uid,
    description,
    tags: ['kora', 'goal-10'],
    timezone: 'utc',
    schemaVersion: 39,
    version: 1,
    refresh: '30s',
    time: { from: 'now-6h', to: 'now' },
    templating: { list: [] },
    annotations: { list: [] },
    panels,
  };
}

const q = (expr, legend) => ({ expr, legend });
const OK_GREEN = [{ color: 'red', value: null }, { color: 'green', value: 1 }];

const operations = dashboard(
  'kora-operations',
  'KORA · Operations (feed, orders, fills, robots, kill switch)',
  'Goal 10: operational health of the PAPER platform. Every panel links to an SLO in docs/runbooks/slos.md; alerts in infra/prometheus/alerts.yml link to the runbooks. SIMULATED environment.',
  [
    {
      title: 'Feed health (SLO-4)',
      panels: [
        { type: 'stat', title: 'Feed up', targets: [q('min(kora_feed_up)', 'feed up')], thresholds: OK_GREEN, w: 6 },
        { title: 'Feed status age (s)', unit: 's', targets: [q('kora_feed_status_age_seconds', 'status age')], w: 9 },
        { title: 'Stale symbols', targets: [q('kora_feed_stale_symbols', 'stale')], w: 9 },
      ],
    },
    {
      title: 'Order latency and rejections (SLO-2)',
      panels: [
        {
          title: 'Order acknowledgement p50 / p95 / p99',
          unit: 's',
          targets: [
            q('histogram_quantile(0.5, sum by (le) (rate(kora_order_submit_seconds_bucket[5m])))', 'p50'),
            q('histogram_quantile(0.95, sum by (le) (rate(kora_order_submit_seconds_bucket[5m])))', 'p95'),
            q('histogram_quantile(0.99, sum by (le) (rate(kora_order_submit_seconds_bucket[5m])))', 'p99'),
          ],
          w: 12,
        },
        { title: 'Orders by outcome (per second)', unit: 'reqps', targets: [q('sum by (outcome) (rate(kora_order_submit_seconds_count[5m]))', '{{outcome}}')], w: 12 },
        { title: 'Rejection reasons (last hour)', type: 'bargauge', targets: [q('sort_desc(sum by (code) (increase(kora_order_rejections_total[1h])))', '{{code}}')], w: 12 },
        { title: 'Orders by source', unit: 'reqps', targets: [q('sum by (source) (rate(kora_order_submit_seconds_count[5m]))', '{{source}}')], w: 12 },
      ],
    },
    {
      title: 'Fills and slippage',
      panels: [
        { title: 'Fills per minute by liquidity', targets: [q('sum by (liquidity) (rate(kora_fills_total[5m])) * 60', '{{liquidity}}')], w: 8 },
        {
          title: 'Slippage p50 / p95 (bps, positive = adverse)',
          targets: [
            q('histogram_quantile(0.5, sum by (le) (rate(kora_fill_slippage_bps_bucket[15m])))', 'p50'),
            q('histogram_quantile(0.95, sum by (le) (rate(kora_fill_slippage_bps_bucket[15m])))', 'p95'),
          ],
          w: 8,
        },
        { title: 'Slippage p95 by symbol (bps)', targets: [q('histogram_quantile(0.95, sum by (le, symbol) (rate(kora_fill_slippage_bps_bucket[1h])))', '{{symbol}}')], w: 8 },
      ],
    },
    {
      title: 'Robots (bot heartbeats)',
      panels: [
        { type: 'stat', title: 'Robots running', targets: [q('kora_robots_running', 'running')], w: 6 },
        { title: 'Oldest runner heartbeat (s)', unit: 's', targets: [q('kora_robot_heartbeat_max_age_seconds', 'max age')], w: 9 },
        { title: 'Supervisor auto-pauses', targets: [q('sum by (reason) (increase(kora_robot_auto_pauses_total[1h]))', '{{reason}}')], w: 9 },
      ],
    },
    {
      title: 'Kill switch (SLO-3)',
      panels: [
        { title: 'Activations by scope', targets: [q('sum by (scope, kind) (increase(kora_kill_switch_activations_total[1h]))', '{{kind}} {{scope}}')], w: 12 },
        { title: 'Completion time p99 (s, objective < 2 s)', unit: 's', targets: [q('histogram_quantile(0.99, sum by (le) (rate(kora_kill_switch_duration_seconds_bucket[1h])))', 'p99')], w: 12 },
      ],
    },
    {
      title: 'API traffic',
      panels: [
        { title: 'Requests by status class', unit: 'reqps', targets: [q('sum by (status) (rate(kora_http_requests_total[5m]))', '{{status}}')], w: 12 },
        { title: 'Slowest routes p95 (s)', unit: 's', targets: [q('topk(5, histogram_quantile(0.95, sum by (le, route) (rate(kora_http_request_duration_seconds_bucket[5m]))))', '{{route}}')], w: 12 },
      ],
    },
  ],
);

const slos = dashboard(
  'kora-slos',
  'KORA · SLOs and error budgets',
  'Goal 10: the proposed SLOs of docs/runbooks/slos.md (OQ-O1, pending Sponsor acceptance) with their error budgets over 30 days.',
  [
    {
      title: 'SLO-1 availability (99.9 %) and error budget',
      panels: [
        { type: 'stat', title: 'Availability, 30 days', unit: 'percentunit', targets: [q('1 - (sum(increase(kora_http_requests_total{status="5xx"}[30d])) / clamp_min(sum(increase(kora_http_requests_total[30d])), 1))', 'availability')], w: 6 },
        {
          type: 'stat',
          title: 'Error budget left (30 days)',
          unit: 'percentunit',
          targets: [q('1 - ((sum(increase(kora_http_requests_total{status="5xx"}[30d])) / clamp_min(sum(increase(kora_http_requests_total[30d])), 1)) / 0.001)', 'budget left')],
          w: 6,
        },
        { title: 'Burn rate (1 h, 5 m)', targets: [q('(sum(rate(kora_http_requests_total{status="5xx"}[1h])) / clamp_min(sum(rate(kora_http_requests_total[1h])), 1e-9)) / 0.001', '1h'), q('(sum(rate(kora_http_requests_total{status="5xx"}[5m])) / clamp_min(sum(rate(kora_http_requests_total[5m])), 1e-9)) / 0.001', '5m')], w: 12 },
      ],
    },
    {
      title: 'SLO-2 order ack p99 < 250 ms, SLO-3 kill switch < 2 s',
      panels: [
        { type: 'stat', title: 'Orders acked within 250 ms (30 days)', unit: 'percentunit', targets: [q('sum(increase(kora_order_submit_seconds_bucket{le="0.25"}[30d])) / clamp_min(sum(increase(kora_order_submit_seconds_count[30d])), 1)', 'within 250 ms')], w: 8 },
        { type: 'stat', title: 'Kill switches within 2 s (30 days)', unit: 'percentunit', targets: [q('sum(increase(kora_kill_switch_duration_seconds_bucket{le="2"}[30d])) / clamp_min(sum(increase(kora_kill_switch_duration_seconds_count[30d])), 1)', 'within 2 s')], w: 8 },
        { title: 'Order ack p99 (s)', unit: 's', targets: [q('histogram_quantile(0.99, sum by (le) (rate(kora_order_submit_seconds_bucket[5m])))', 'p99')], w: 8 },
      ],
    },
    {
      title: 'SLO-4 feed, SLO-6 reconciliation, SLO-8 alerts, SLO-9 copilot',
      panels: [
        { type: 'stat', title: 'Feed up, share of time (30 days)', unit: 'percentunit', targets: [q('avg_over_time(min(kora_feed_up)[30d:5m])', 'feed ok')], w: 6 },
        { type: 'stat', title: 'Seconds since last reconciliation', unit: 's', targets: [q('time() - kora_governance{metric="reconciliation_last_run_ts"}', 'since last run')], w: 6 },
        { type: 'stat', title: 'Unacknowledged critical alerts', targets: [q('kora_governance{metric="alerts_open_critical"}', 'open critical')], w: 6 },
        { type: 'stat', title: 'Copilot answered (30 days)', unit: 'percentunit', targets: [q('1 - sum(increase(kora_ai_requests_total{status=~"error|unavailable"}[30d])) / clamp_min(sum(increase(kora_ai_requests_total[30d])), 1)', 'answered')], w: 6 },
      ],
    },
    {
      title: 'SLO-10/11 backup and restore, SLO-12 audit chain',
      panels: [
        { type: 'stat', title: 'Hours since last restore test', unit: 'h', targets: [q('(time() - kora_governance{metric="backup_last_success_ts"}) / 3600', 'hours')], w: 12 },
        { type: 'stat', title: 'Hours since last signed audit anchor', unit: 'h', targets: [q('(time() - kora_governance{metric="anchor_last_success_ts"}) / 3600', 'hours')], w: 12 },
      ],
    },
  ],
);

const governance = dashboard(
  'kora-governance',
  'KORA · Governance and risk operations',
  'Goal 10 (B-916): four-eyes backlog, open critical alerts and incidents, alert relay, anchor and backup jobs.',
  [
    {
      title: 'Second line',
      panels: [
        { type: 'stat', title: 'Four-eyes requests pending', targets: [q('kora_governance{metric="four_eyes_pending"}', 'pending')], w: 6 },
        { type: 'stat', title: 'Open critical alerts', targets: [q('kora_governance{metric="alerts_open_critical"}', 'critical')], w: 6 },
        { type: 'stat', title: 'Open P1/P2 incidents', targets: [q('kora_governance{metric="incidents_open_p1p2"}', 'P1/P2')], w: 6 },
        { type: 'stat', title: 'Open reconciliation breaks', targets: [q('kora_governance{metric="reconciliation_breaks_open"}', 'breaks')], w: 6 },
      ],
    },
    {
      title: 'Alert relay (NOTIFY → WS, SLO-7)',
      panels: [{ title: 'Relayed alerts by result', targets: [q('sum by (result) (increase(kora_alert_relay_total[1h]))', '{{result}}')], w: 24 }],
    },
  ],
);

for (const [file, d] of [
  ['kora-operations.json', operations],
  ['kora-slos.json', slos],
  ['kora-governance.json', governance],
]) {
  writeFileSync(join(OUT, file), `${JSON.stringify(d, null, 2)}\n`);
  console.warn(`[dashboards] wrote ${file} (${d.panels.length} panels)`);
}
