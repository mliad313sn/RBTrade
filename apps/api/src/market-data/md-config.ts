import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const Schema = z.object({
  /** inprocess: the api runs the feed; off: the feed runs elsewhere (`md:feed`). */
  KORA_MD_FEED: z.enum(['inprocess', 'off']).default('inprocess'),
  KORA_MD_SEED: z.string().min(1).max(128).default('kora-sim'),
  KORA_MD_STEP_MS: z.coerce.number().int().min(10).max(10_000).default(100),
  /** Optional comma list to restrict the simulated universe (default: every active registry row). */
  KORA_MD_SYMBOLS: z.string().optional().default(''),
  KORA_MD_BACKFILL: bool(true),
  KORA_MD_HISTORY_DAYS: z.coerce.number().int().min(1).max(60).default(10),
  /** Unset: follow venue sessions outside dev/test (B-208); dev and test simulate 24/7 by default. */
  KORA_MD_RESPECT_SESSIONS: z.enum(['true', 'false', '1', '0', '']).optional(),
  KORA_ENV: z.enum(['dev', 'test', 'staging', 'production']).default('dev'),
  KORA_MD_DEPTH_LEVELS: z.coerce.number().int().min(1).max(50).default(10),
  KORA_MD_HEARTBEAT_MS: z.coerce.number().int().min(100).max(10_000).default(1000),
  /** Gateway declares the feed lost when no status heartbeat arrives for this long. */
  KORA_MD_FEED_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(2500),
  KORA_MD_STALE_CHECK_MS: z.coerce.number().int().min(50).max(5000).default(250),
  KORA_MD_ROLLUP_MS: z.coerce.number().int().min(500).max(60_000).default(2000),
  KORA_MD_WS_MAX_CHANNELS: z.coerce.number().int().min(1).max(5000).default(300),
  KORA_MD_WS_ORIGINS: z.string().optional().default(''),
  /** B-203: open sockets allowed per signed-in user and per remote IP address. */
  KORA_MD_WS_MAX_CONN_PER_USER: z.coerce.number().int().min(1).max(100_000).default(20),
  KORA_MD_WS_MAX_CONN_PER_IP: z.coerce.number().int().min(1).max(100_000).default(200),
  KORA_MD_CONFLATE_PER_SEC: z.coerce.number().int().min(1).max(100).default(10),
  KORA_MD_CONFLATE_BURST: z.coerce.number().int().min(1).max(20).default(2),
  /** Per-client write coalescing window (ms); 0 = flush at the end of the event-loop turn. */
  KORA_MD_WS_FLUSH_MS: z.coerce.number().int().min(0).max(50).default(0),
  /** IRTC R1-03: how often open sockets are re-checked against server-side session state (ms). */
  KORA_WS_SESSION_SWEEP_MS: z.coerce.number().int().min(200).max(300_000).default(15_000),
  /** Redis namespace (tests use their own so they never cross-talk with a dev api). */
  KORA_MD_REDIS_PREFIX: z.string().regex(/^[a-z0-9:_-]{1,64}:$/).default('kora:md:'),
});

export type MdConfig = ReturnType<typeof loadMdConfig>;

export function loadMdConfig(env: NodeJS.ProcessEnv = process.env, webOrigin = 'http://localhost:3000') {
  const e = Schema.parse(env);
  return {
    feed: e.KORA_MD_FEED,
    seed: e.KORA_MD_SEED,
    stepMs: e.KORA_MD_STEP_MS,
    symbols: e.KORA_MD_SYMBOLS.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
    backfill: e.KORA_MD_BACKFILL,
    historyDays: e.KORA_MD_HISTORY_DAYS,
    respectSessions:
      e.KORA_MD_RESPECT_SESSIONS === undefined || e.KORA_MD_RESPECT_SESSIONS === ''
        ? e.KORA_ENV !== 'dev' && e.KORA_ENV !== 'test'
        : e.KORA_MD_RESPECT_SESSIONS === 'true' || e.KORA_MD_RESPECT_SESSIONS === '1',
    depthLevels: e.KORA_MD_DEPTH_LEVELS,
    heartbeatMs: e.KORA_MD_HEARTBEAT_MS,
    feedTimeoutMs: e.KORA_MD_FEED_TIMEOUT_MS,
    staleCheckMs: e.KORA_MD_STALE_CHECK_MS,
    rollupMs: e.KORA_MD_ROLLUP_MS,
    wsMaxChannels: e.KORA_MD_WS_MAX_CHANNELS,
    wsOrigins: [webOrigin, ...e.KORA_MD_WS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)],
    conflatePerSec: e.KORA_MD_CONFLATE_PER_SEC,
    conflateBurst: e.KORA_MD_CONFLATE_BURST,
    prefix: e.KORA_MD_REDIS_PREFIX,
    wsFlushMs: e.KORA_MD_WS_FLUSH_MS,
    wsMaxConnPerUser: e.KORA_MD_WS_MAX_CONN_PER_USER,
    wsMaxConnPerIp: e.KORA_MD_WS_MAX_CONN_PER_IP,
    wsSessionSweepMs: e.KORA_WS_SESSION_SWEEP_MS,
  };
}

export const MD_CONFIG = Symbol('MD_CONFIG');

/** Redis naming. Client channel names (quotes:EURUSD) are prefixed on the bus. */
export const busChannel = (cfg: Pick<MdConfig, 'prefix'>, clientChannel: string): string => `${cfg.prefix}${clientChannel}`;
export const lastKey = (cfg: Pick<MdConfig, 'prefix'>, clientChannel: string): string => `${cfg.prefix}last:${clientChannel}`;
