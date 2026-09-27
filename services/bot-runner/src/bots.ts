import { EventEmitter } from 'node:events';

import type { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import { withSpan } from './tracing.js';
import type { RunnerConfig } from './config.js';
import { barJobId, type BarCloseJob } from './jobs.js';

/**
 * Robot control plane on Redis, under `KORA_ROBOT_CTL_PREFIX` (default `kora:`), the same prefix the
 * api uses (IRTC R6: a test or e2e run gets its own prefix, so other runners cannot interfere).
 * - control: the goal 03 kill switch (halt / resume) and the api's robot sync;
 * - events: what the runner did (halts with latency, decisions), for monitoring and tests.
 */
export const robotControlChannel = (prefix = 'kora:'): string => `${prefix}ctl:robots`;
export const robotEventsChannel = (prefix = 'kora:'): string => `${prefix}robots:events`;
export const heartbeatKey = (robotId: string, prefix = 'kora:'): string => `${prefix}robots:hb:${robotId}`;

export interface RunningRobot {
  robotId: string;
  accountId: string;
  versionId: string;
  timeframe: BarCloseJob['tf'];
  symbols: string[];
}

interface ControlMessage {
  action: 'halt' | 'resume' | 'sync';
  accountId: string;
  robotId?: string;
  ts?: number;
}

export class TransientError extends Error {}

/** Minimal JSON client for the api's internal endpoints and quant. */
export class Http {
  constructor(private readonly cfg: RunnerConfig) {}

  async call<T>(
    base: 'api' | 'quant',
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${base === 'api' ? this.cfg.apiUrl : this.cfg.quantUrl}${path}`;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (base === 'api') {
      headers['x-kora-service-token'] = this.cfg.serviceToken ?? '';
      headers['x-kora-csrf'] = '1';
    }
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.requestTimeoutMs),
      });
    } catch (e) {
      throw new TransientError(`${base} unreachable: ${(e as Error).message}`);
    }
    const text = await res.text();
    const data = text ? (JSON.parse(text) as unknown) : undefined;
    if (!res.ok) {
      const err = (data as { error?: string; message?: string } | undefined) ?? {};
      const msg =
        `${base} ${method} ${path} → ${res.status} ${err.error ?? ''} ${err.message ?? ''}`.trim();
      if (res.status >= 500 || err.error === 'bar_not_ready') throw new TransientError(msg);
      throw Object.assign(new Error(msg), { status: res.status, code: err.error });
    }
    return data as T;
  }
}

/**
 * The runner's robot state: which robots run, which candle channels to watch, heartbeats, and the
 * kill-switch reaction. A halt message marks the account's robots halted immediately (no network
 * round trip), drops their queued bar jobs, stops their heartbeats and reports the reaction time.
 */
export class Bots extends EventEmitter {
  readonly robots = new Map<string, RunningRobot>();
  readonly haltedAccounts = new Set<string>();
  private readonly channels = new Set<string>();
  private readonly sub: Redis;
  private readonly pub: Redis;
  private readonly timers: NodeJS.Timeout[] = [];
  private syncing: Promise<void> | null = null;

  constructor(
    private readonly cfg: RunnerConfig,
    private readonly queue: Queue,
    readonly http: Http,
  ) {
    super();
    this.sub = new Redis(cfg.redisUrl, { maxRetriesPerRequest: null });
    this.pub = new Redis(cfg.redisUrl, { maxRetriesPerRequest: 2 });
    this.sub.on('error', () => undefined);
    this.pub.on('error', () => undefined);
  }

  async start(): Promise<void> {
    this.sub.on('message', (channel: string, raw: string) => {
      if (channel === robotControlChannel(this.cfg.ctlPrefix)) void this.onControl(raw);
      else void this.onCandle(channel, raw);
    });
    await this.sub.subscribe(robotControlChannel(this.cfg.ctlPrefix));
    await this.sync().catch((e: Error) => this.emit('error', e));
    this.timers.push(
      setInterval(
        () => void this.sync().catch((e: Error) => this.emit('error', e)),
        this.cfg.syncMs,
      ),
    );
    this.timers.push(setInterval(() => void this.beat(), this.cfg.heartbeatMs));
    await this.beat();
  }

  isActive(robotId: string): boolean {
    const r = this.robots.get(robotId);
    return !!r && !this.haltedAccounts.has(r.accountId);
  }

  /** Reloads the running robots from the api and (un)subscribes candle channels. */
  sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      const { robots } = await this.http.call<{ robots: RunningRobot[] }>(
        'api',
        'GET',
        '/internal/robots/running',
      );
      const seenAccounts = new Set(robots.map((r) => r.accountId));
      this.robots.clear();
      for (const r of robots) this.robots.set(r.robotId, r);
      // A robot the api reports running again after a resume and a manual restart is live again.
      for (const a of [...this.haltedAccounts])
        if (!seenAccounts.has(a)) this.haltedAccounts.delete(a);
      const want = new Set(
        robots.flatMap((r) =>
          r.symbols.map((s) => `${this.cfg.mdPrefix}candles:${s}:${r.timeframe}`),
        ),
      );
      const add = [...want].filter((c) => !this.channels.has(c));
      const drop = [...this.channels].filter((c) => !want.has(c));
      if (add.length) await this.sub.subscribe(...add);
      if (drop.length) await this.sub.unsubscribe(...drop);
      for (const c of add) this.channels.add(c);
      for (const c of drop) this.channels.delete(c);
      this.emit('synced', robots.length);
    })().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async onControl(raw: string): Promise<void> {
    let msg: ControlMessage;
    try {
      msg = JSON.parse(raw) as ControlMessage;
    } catch {
      return;
    }
    if (msg.action === 'halt' && msg.accountId) {
      const reactedAt = Date.now();
      this.haltedAccounts.add(msg.accountId);
      const robotIds = [...this.robots.values()]
        .filter((r) => r.accountId === msg.accountId)
        .map((r) => r.robotId);
      if (robotIds.length) await this.pub.del(...robotIds.map((id) => heartbeatKey(id, this.cfg.ctlPrefix))).catch(() => undefined);
      const event = {
        type: 'halted',
        accountId: msg.accountId,
        robotIds,
        reactedAt,
        latencyMs: msg.ts ? reactedAt - msg.ts : null,
      };
      this.emit('halted', event);
      await this.pub.publish(robotEventsChannel(this.cfg.ctlPrefix), JSON.stringify(event)).catch(() => undefined);
      await this.dropQueued(new Set(robotIds));
      return;
    }
    if (msg.action === 'sync' || msg.action === 'resume')
      await this.sync().catch((e: Error) => this.emit('error', e));
  }

  private async dropQueued(robotIds: Set<string>): Promise<void> {
    if (!robotIds.size) return;
    const jobs = await this.queue.getJobs(['waiting', 'delayed', 'prioritized']);
    await Promise.all(
      jobs
        .filter((j) => robotIds.has((j.data as { robotId?: string }).robotId ?? ''))
        .map((j) => j.remove().catch(() => undefined)),
    );
  }

  private async onCandle(channel: string, raw: string): Promise<void> {
    let c: { type?: string; symbol?: string; tf?: string; bucket?: number; closed?: boolean };
    try {
      c = JSON.parse(raw) as typeof c;
    } catch {
      return;
    }
    if (c.type !== 'candle' || !c.closed || !c.symbol || !c.tf || typeof c.bucket !== 'number')
      return;
    for (const r of this.robots.values()) {
      if (r.timeframe !== c.tf || !r.symbols.includes(c.symbol) || !this.isActive(r.robotId))
        continue;
      const job: BarCloseJob = {
        type: 'bar_close',
        robotId: r.robotId,
        symbol: c.symbol,
        tf: r.timeframe,
        barTs: c.bucket,
      };
      await this.queue.add('bar_close', job, {
        jobId: barJobId(job),
        attempts: 8,
        backoff: { type: 'exponential', delay: 250 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      });
      this.emit('enqueued', { channel, job });
    }
  }

  /** Refreshes every active robot's heartbeat key (TTL 60 s; the api pauses after 3 missed beats). */
  async beat(): Promise<void> {
    const now = Date.now();
    const pipe = this.pub.multi();
    let n = 0;
    for (const r of this.robots.values()) {
      if (!this.isActive(r.robotId)) continue;
      pipe.set(heartbeatKey(r.robotId, this.cfg.ctlPrefix), String(now), 'EX', 60);
      n += 1;
    }
    pipe.set(`${this.cfg.ctlPrefix}robots:runner:hb`, String(now), 'EX', 60);
    await pipe.exec().catch(() => undefined);
    this.emit('beat', n);
  }

  /** Evaluates one closed bar: context (api) → decision (quant) → act (api → OMS). */
  async processBar(job: BarCloseJob): Promise<Record<string, unknown>> {
    // Goal 10: one trace per bar close, runner → api → quant → api → OMS.
    return withSpan('runner.bar_close', { 'kora.robot_id': job.robotId, 'kora.symbol': job.symbol, 'kora.bar_ts': job.barTs }, () =>
      this.processBarInSpan(job),
    );
  }

  private async processBarInSpan(job: BarCloseJob): Promise<Record<string, unknown>> {
    if (!this.isActive(job.robotId)) return { skipped: 'robot_not_active' };
    const ctx = await this.http.call<{ versionId: string; signalRequest: unknown }>(
      'api',
      'GET',
      `/internal/robots/${job.robotId}/context?symbol=${encodeURIComponent(job.symbol)}&barTs=${job.barTs}`,
    );
    const signal = await this.http.call<Record<string, unknown>>(
      'quant',
      'POST',
      '/bt/signal',
      ctx.signalRequest,
    );
    // Re-check right before acting: a halt may have arrived while quant was thinking.
    if (!this.isActive(job.robotId)) return { skipped: 'halted_during_evaluation' };
    const decision = await this.http.call<Record<string, unknown>>(
      'api',
      'POST',
      `/internal/robots/${job.robotId}/decisions`,
      {
        symbol: job.symbol,
        barTs: job.barTs,
        versionId: ctx.versionId,
        signal,
      },
    );
    const event = {
      type: 'decision',
      robotId: job.robotId,
      symbol: job.symbol,
      barTs: job.barTs,
      action: decision.action,
      outcome: decision.outcome,
      orderId: decision.orderId ?? null,
    };
    this.emit('decision', event);
    await this.pub.publish(robotEventsChannel(this.cfg.ctlPrefix), JSON.stringify(event)).catch(() => undefined);
    return event;
  }

  async close(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.sub.disconnect();
    this.pub.disconnect();
  }
}
