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
    const c = loadConfig({ ...base, AUTH_PROVIDER: 'keycloak', KEYCLOAK_URL: 'http://kc:8080/', KORA_ENV: 'staging' });
    expect(c.auth.issuer).toBe('http://kc:8080/realms/kora');
    expect(c.auth.secureCookies).toBe(true);
  });
  it('validates scrypt cost', () => {
    expect(() => loadConfig({ ...base, KORA_SCRYPT_N: '1000' })).toThrow(/power of two/);
  });
});
