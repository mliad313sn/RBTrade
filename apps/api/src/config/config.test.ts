import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config';

const base = { DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x' };

describe('loadConfig', () => {
  it('defaults to PAPER, dev IdP and never enables LIVE', () => {
    const c = loadConfig(base);
    expect(c.tradingEnvironment).toBe('PAPER');
    expect(c.liveTradingEnabled).toBe(false);
    expect(c.auth.provider).toBe('dev');
    expect(c.auth.secureCookies).toBe(false);
  });
  it('refuses LIVE_TRADING_ENABLED=true', () => {
    expect(() => loadConfig({ ...base, LIVE_TRADING_ENABLED: 'true' })).toThrow(ConfigError);
  });
  it('refuses the dev IdP in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/never run in production/);
  });
  it('requires database and redis urls', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
  it('derives the keycloak issuer', () => {
    const c = loadConfig({ ...base, AUTH_PROVIDER: 'keycloak', KEYCLOAK_URL: 'http://kc:8080/', KORA_ENV: 'staging', KORA_ALLOW_INSECURE_TRANSPORT: 'true' });
    expect(c.auth.issuer).toBe('http://kc:8080/realms/kora');
    expect(c.auth.secureCookies).toBe(true);
  });
  it('goal 09: staging and production require TLS to Postgres and Redis (unless explicitly allowed for local compose)', () => {
    const kc = { AUTH_PROVIDER: 'keycloak', KORA_ENV: 'staging' };
    expect(() => loadConfig({ ...base, ...kc })).toThrow(/DATABASE_URL must use TLS/);
    expect(() => loadConfig({ ...kc, DATABASE_URL: 'postgres://x?sslmode=require', REDIS_URL: 'redis://x' })).toThrow(/rediss/);
    expect(loadConfig({ ...kc, DATABASE_URL: 'postgres://x?sslmode=verify-full', REDIS_URL: 'rediss://x' }).env).toBe('staging');
    expect(loadConfig({ ...base, ...kc, KORA_ALLOW_INSECURE_TRANSPORT: 'true' }).env).toBe('staging');
    expect(loadConfig(base).env).toBe('dev');
  });
  it('validates scrypt cost', () => {
    expect(() => loadConfig({ ...base, KORA_SCRYPT_N: '1000' })).toThrow(/power of two/);
  });
});
