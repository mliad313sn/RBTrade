// Runs in every integration test worker before any app module is imported.
import '../src/env';

process.env.KORA_ENV = 'test';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST ?? '';
process.env.KORA_SCRYPT_N = '16384';
process.env.KORA_AUTH_RATE_LIMIT = '10000';
// IRTC R1-11 per-IP sign-up / assessment ceilings (their own tests run at the defaults).
process.env.KORA_SIGNUP_RATE_LIMIT_PER_HOUR = '100000';
process.env.KORA_APPROPRIATENESS_IP_LIMIT_PER_DAY = '100000';
process.env.LOG_LEVEL = 'silent';
process.env.AUTH_PROVIDER = 'dev';
process.env.LIVE_TRADING_ENABLED = 'false';
process.env.KORA_MD_FEED ??= 'off';
process.env.KORA_MD_BACKFILL ??= 'false';
process.env.KORA_MD_REDIS_PREFIX ??= `kora:test:${process.pid}:md:`;
// IRTC R6: this worker's own robot control plane (kill-switch channel, runner events, heartbeats),
// inherited by the bot runners and apis the tests spawn; other runs on the same Redis cannot interfere.
process.env.KORA_ROBOT_CTL_PREFIX ??= `kora:test:${process.pid}:`;
