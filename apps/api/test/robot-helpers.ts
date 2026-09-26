import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

import { Redis } from 'ioredis';

import { ownerQuery } from './helpers';

const ROOT = resolve(__dirname, '../../..');

export async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });
}

async function waitFor(
  url: string,
  timeoutMs: number,
  proc: ChildProcess,
  logs: string[],
): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (exited(proc))
      throw new Error(`process exited (${proc.exitCode}): ${logs.join('').slice(-2000)}`);
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timeout waiting for ${url}: ${logs.join('').slice(-2000)}`);
}

export interface Spawned {
  url: string;
  proc: ChildProcess;
  logs: string[];
  stop: () => Promise<void>;
}

function track(proc: ChildProcess): string[] {
  const logs: string[] = [];
  proc.stdout?.on('data', (d: Buffer) => logs.push(d.toString()));
  proc.stderr?.on('data', (d: Buffer) => logs.push(d.toString()));
  return logs;
}

const exited = (p: ChildProcess) => p.exitCode !== null || p.signalCode !== null;

/** Stops the whole process group (pnpm → tsx → node, bash → python), SIGKILL after 5 s. */
async function stopProc(proc: ChildProcess): Promise<void> {
  if (exited(proc)) return;
  const kill = (sig: NodeJS.Signals) => {
    try {
      process.kill(-proc.pid!, sig);
    } catch {
      proc.kill(sig);
    }
  };
  await new Promise<void>((r) => {
    proc.once('exit', () => r());
    kill('SIGTERM');
    setTimeout(() => kill('SIGKILL'), 5000).unref();
  });
}

/** The real quant service (services/quant/.venv via scripts/py-run.sh) on a free port. */
export async function startQuant(): Promise<Spawned> {
  const port = await freePort();
  const proc = spawn(
    'bash',
    [
      '../../scripts/py-run.sh',
      'python',
      '-m',
      'uvicorn',
      'kora_quant.app:app',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--app-dir',
      'src',
    ],
    {
      cwd: resolve(ROOT, 'services/quant'),
      env: { ...process.env, LIVE_TRADING_ENABLED: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  );
  const logs = track(proc);
  const url = `http://127.0.0.1:${port}`;
  await waitFor(`${url}/health`, 120_000, proc, logs);
  return { url, proc, logs, stop: () => stopProc(proc) };
}

/** The real bot runner process (tsx, no build needed) pointed at the test api and quant. */
export async function startBotRunner(env: Record<string, string>): Promise<Spawned> {
  const port = await freePort();
  const proc = spawn('pnpm', ['exec', 'tsx', 'src/main.ts'], {
    cwd: resolve(ROOT, 'services/bot-runner'),
    env: {
      ...process.env,
      BOT_RUNNER_HEALTH_PORT: String(port),
      BOT_RUNNER_QUEUE: `kora-bots-it-${process.pid}-${port}`,
      KORA_BOT_RUNNER_TRACKING_CRON: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const logs = track(proc);
  const url = `http://127.0.0.1:${port}`;
  await waitFor(`${url}/health`, 60_000, proc, logs);
  return { url, proc, logs, stop: () => stopProc(proc) };
}

export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

/** Writes SIMULATED history candles (owner connection), replacing any existing bucket. */
export async function seedCandles(
  symbol: string,
  tf: string,
  bars: Bar[],
  decimals: number,
): Promise<void> {
  for (let i = 0; i < bars.length; i += 2000) {
    const chunk = bars.slice(i, i + 2000);
    await ownerQuery(
      `INSERT INTO md_candles_history (symbol, tf, bucket, open, high, low, close, volume, trades, source)
       SELECT $1, $2, to_timestamp(b / 1000.0), o, h, l, c, 1, 1, 'test-simulated'
       FROM unnest($3::bigint[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[]) AS x(b, o, h, l, c)
       ON CONFLICT (symbol, tf, bucket) DO UPDATE SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close`,
      [
        symbol,
        tf,
        chunk.map((b) => b.t),
        chunk.map((b) => b.o.toFixed(decimals)),
        chunk.map((b) => b.h.toFixed(decimals)),
        chunk.map((b) => b.l.toFixed(decimals)),
        chunk.map((b) => b.c.toFixed(decimals)),
      ],
    );
  }
}

/** Deterministic oscillating series on a tick grid: open = previous close. */
export function wave(
  n: number,
  t0: number,
  stepMs: number,
  opts: { base: number; amp: number; period: number; tick: number; drift?: number },
): Bar[] {
  const round = (x: number) => Math.round(x / opts.tick) * opts.tick;
  const bars: Bar[] = [];
  let prev = round(opts.base);
  for (let i = 0; i < n; i++) {
    const c = round(
      opts.base +
        opts.amp * Math.sin((2 * Math.PI * i) / opts.period) +
        (opts.drift ?? 0) * i +
        ((i * 7919) % 13) * opts.tick,
    );
    const o = prev;
    const h = round(Math.max(o, c) + 3 * opts.tick);
    const l = round(Math.min(o, c) - 3 * opts.tick);
    bars.push({ t: t0 + i * stepMs, o, h, l, c });
    prev = c;
  }
  return bars;
}

/** Collects `kora:robots:events` messages from the runner. */
export class RunnerEvents {
  readonly events: Array<Record<string, unknown> & { receivedAt: number }> = [];
  private readonly sub: Redis;

  constructor() {
    this.sub = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:56379', {
      maxRetriesPerRequest: null,
    });
  }

  async start(): Promise<void> {
    await this.sub.subscribe('kora:robots:events');
    this.sub.on('message', (_c: string, raw: string) =>
      this.events.push({ ...(JSON.parse(raw) as Record<string, unknown>), receivedAt: Date.now() }),
    );
  }

  async wait(
    pred: (e: Record<string, unknown>) => boolean,
    timeoutMs = 15_000,
  ): Promise<Record<string, unknown> & { receivedAt: number }> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const e = this.events.find(pred);
      if (e) return e;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(
      `timeout waiting for a runner event; seen ${JSON.stringify(this.events.slice(-5))}`,
    );
  }

  close(): void {
    this.sub.disconnect();
  }
}

export const TOKEN = 'it-service-token-0123456789abcdef-0123456789';
