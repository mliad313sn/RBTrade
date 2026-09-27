import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';

/** One Prometheus registry per api process, shared by every module (served at GET /metrics). */
@Injectable()
export class MetricsRegistry {
  readonly registry = new Registry();
}

/** Scrape-time readers registered by the modules that own the data (feed, governance, robots). */
export type GaugeReader = () => Promise<void> | void;

/**
 * Operational metrics (goal 10, B-012/B-916): HTTP SLIs, the order path, fills and slippage,
 * kill switch, feed health, robots, and governance health. Dashboards in
 * `infra/grafana/provisioning/dashboards/`, alert rules in `infra/prometheus/alerts.yml`.
 */
@Injectable()
export class OpsMetrics {
  private readonly readers: GaugeReader[] = [];
  readonly http: Counter<'method' | 'route' | 'status'>;
  readonly httpDuration: Histogram<'method' | 'route'>;
  readonly orderSubmit: Histogram<'outcome' | 'source'>;
  readonly orderRejections: Counter<'code'>;
  readonly fills: Counter<'liquidity'>;
  readonly slippageBps: Histogram<'symbol'>;
  readonly killSwitch: Counter<'scope' | 'kind'>;
  readonly killSwitchDuration: Histogram<'scope'>;
  readonly robotAutoPauses: Counter<'reason'>;
  readonly robotsRunning: Gauge;
  readonly robotHeartbeatMaxAge: Gauge;
  readonly feedUp: Gauge<'source'>;
  readonly feedStatusAge: Gauge;
  readonly feedStaleSymbols: Gauge;
  readonly alertRelay: Counter<'result'>;
  readonly governance: Gauge<'metric'>;

  constructor(reg: MetricsRegistry) {
    const registers = [reg.registry];
    this.http = new Counter({ name: 'kora_http_requests_total', help: 'HTTP requests by method, route template and status class', labelNames: ['method', 'route', 'status'], registers });
    this.httpDuration = new Histogram({
      name: 'kora_http_request_duration_seconds',
      help: 'HTTP request latency by route template',
      labelNames: ['method', 'route'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers,
    });
    this.orderSubmit = new Histogram({
      name: 'kora_order_submit_seconds',
      help: 'Order acknowledgement latency (OMS submit incl. risk and audit), SLO-2',
      labelNames: ['outcome', 'source'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers,
    });
    this.orderRejections = new Counter({ name: 'kora_order_rejections_total', help: 'Pre-trade risk rejections by risk code', labelNames: ['code'], registers });
    this.fills = new Counter({ name: 'kora_fills_total', help: 'Paper fills by liquidity', labelNames: ['liquidity'], registers });
    this.slippageBps = new Histogram({
      name: 'kora_fill_slippage_bps',
      help: 'Fill slippage vs the reference price in basis points (positive = adverse)',
      labelNames: ['symbol'],
      buckets: [-10, -5, -1, 0, 1, 2, 5, 10, 25, 50, 100],
      registers,
    });
    this.killSwitch = new Counter({ name: 'kora_kill_switch_activations_total', help: 'Kill switch activations by scope (account or firm)', labelNames: ['scope', 'kind'], registers });
    this.killSwitchDuration = new Histogram({
      name: 'kora_kill_switch_duration_seconds',
      help: 'Kill switch completion time, SLO-3 (< 2 s)',
      labelNames: ['scope'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
      registers,
    });
    this.robotAutoPauses = new Counter({ name: 'kora_robot_auto_pauses_total', help: 'Supervisor auto-pauses by reason', labelNames: ['reason'], registers });
    this.robotsRunning = new Gauge({ name: 'kora_robots_running', help: 'Robots in the running state', registers });
    this.robotHeartbeatMaxAge = new Gauge({ name: 'kora_robot_heartbeat_max_age_seconds', help: 'Oldest runner heartbeat among running robots', registers });
    this.feedUp = new Gauge({ name: 'kora_feed_up', help: 'Market data feed up (1) or down (0) by source', labelNames: ['source'], registers });
    this.feedStatusAge = new Gauge({ name: 'kora_feed_status_age_seconds', help: 'Age of the last feed status heartbeat', registers });
    this.feedStaleSymbols = new Gauge({ name: 'kora_feed_stale_symbols', help: 'Symbols currently flagged stale', registers });
    this.alertRelay = new Counter({ name: 'kora_alert_relay_total', help: 'Risk alert relay (NOTIFY → WS) by result', labelNames: ['result'], registers });
    this.governance = new Gauge({
      name: 'kora_governance',
      help: 'Governance health: four_eyes_pending, alerts_open_critical, anchor_last_success_ts, backup_last_success_ts, reconciliation_last_run_ts, reconciliation_breaks_open, incidents_open_p1p2',
      labelNames: ['metric'],
      registers,
      collect: async () => {
        for (const r of this.readers) await r();
      },
    });
  }

  /** Slippage in bps (a decimal string from the engine; metrics are floats by nature, money is not). */
  observeSlippageBps(symbol: string, bps: string): void {
    this.slippageBps.observe({ symbol }, Number(bps));
  }

  /** Registers a scrape-time reader (called once per scrape, errors are swallowed per reader). */
  onScrape(reader: GaugeReader): void {
    this.readers.push(async () => {
      try {
        await reader();
      } catch {
        /* a failing source must not break the scrape */
      }
    });
  }
}
