// Runs in every integration test worker before any app module is imported.
import '../src/env';

process.env.KORA_ENV = 'test';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST ?? '';
process.env.KORA_SCRYPT_N = '16384';
process.env.KORA_AUTH_RATE_LIMIT = '10000';
process.env.LOG_LEVEL = 'silent';
process.env.AUTH_PROVIDER = 'dev';
process.env.LIVE_TRADING_ENABLED = 'false';
