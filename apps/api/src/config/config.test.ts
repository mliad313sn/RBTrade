import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config';

const base = { DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x' };

describe('loadConfig', () => {
  it('defaults to PAPER, dev IdP and never enables LIVE', () => {
    const c = loadConfig({ ...base, KORA_ENV: 'dev' });
    expect(c.tradingEnvironment).toBe('PAPER');
    expect(c.liveTradingEnabled).toBe(false);
    expect(c.auth.provider).toBe('dev');
    expect(c.auth.secureCookies).toBe(false);
    expect(c.apiDocs).toBe(true);
  });
  it('IRTC R6-12: with KORA_ENV unset the dev leniencies are off (secure cookies, no API docs)', () => {
    const c = loadConfig(base);
    expect(c.auth.secureCookies).toBe(true);
    expect(c.apiDocs).toBe(false);
  });
  it('refuses LIVE_TRADING_ENABLED=true', () => {
    expect(() => loadConfig({ ...base, LIVE_TRADING_ENABLED: 'true' })).toThrow(ConfigError);
  });
  it('refuses the dev IdP in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(
      /never run in production/,
    );
  });
  it('requires database and redis urls', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
  it('derives the keycloak issuer', () => {
    const c = loadConfig({
      ...base,
      REDIS_URL: 'redis://:pw@x',
      AUTH_PROVIDER: 'keycloak',
      KEYCLOAK_URL: 'http://kc:8080/',
      KORA_ENV: 'staging',
      KORA_ALLOW_INSECURE_TRANSPORT: 'true',
    });
    expect(c.auth.issuer).toBe('http://kc:8080/realms/kora');
    expect(c.auth.secureCookies).toBe(true);
  });
  it('goal 09: staging and production require TLS to Postgres and Redis (unless explicitly allowed for local compose)', () => {
    const kc = { AUTH_PROVIDER: 'keycloak', KORA_ENV: 'staging' };
    expect(() => loadConfig({ ...base, ...kc })).toThrow(/DATABASE_URL must use TLS/);
    expect(() =>
      loadConfig({ ...kc, DATABASE_URL: 'postgres://x?sslmode=require', REDIS_URL: 'redis://x' }),
    ).toThrow(/rediss/);
    expect(
      loadConfig({
        ...kc,
        DATABASE_URL: 'postgres://x?sslmode=verify-full',
        REDIS_URL: 'rediss://:pw@x',
      }).env,
    ).toBe('staging');
    expect(
      loadConfig({
        ...base,
        ...kc,
        REDIS_URL: 'redis://:pw@x',
        KORA_ALLOW_INSECURE_TRANSPORT: 'true',
      }).env,
    ).toBe('staging');
    expect(loadConfig(base).env).toBe('dev');
  });
  it('IRTC R1-11: staging and production require Redis authentication', () => {
    const kc = {
      AUTH_PROVIDER: 'keycloak',
      KORA_ENV: 'staging',
      DATABASE_URL: 'postgres://x?sslmode=require',
    };
    expect(() => loadConfig({ ...kc, REDIS_URL: 'rediss://redis:6380' })).toThrow(/password/);
    expect(loadConfig({ ...kc, REDIS_URL: 'rediss://:s3cret@redis:6380' }).env).toBe('staging');
    expect(loadConfig({ ...kc, REDIS_URL: 'rediss://kora:s3cret@redis:6380' }).env).toBe('staging');
    expect(() =>
      loadConfig({ ...kc, KORA_ENV: 'production', REDIS_URL: 'rediss://redis:6380' }),
    ).toThrow(/password/);
    // the local-compose TLS escape hatch does not waive authentication
    expect(() =>
      loadConfig({
        ...base,
        AUTH_PROVIDER: 'keycloak',
        KORA_ENV: 'staging',
        KORA_ALLOW_INSECURE_TRANSPORT: 'true',
      }),
    ).toThrow(/password/);
    expect(loadConfig(base).env).toBe('dev');
  });
  it('IRTC R1-11: the dev IdP is refused in staging unless explicitly allowed, and then only with persistent keys', () => {
    const st = {
      DATABASE_URL: 'postgres://x?sslmode=require',
      REDIS_URL: 'rediss://:pw@x',
      KORA_ENV: 'staging',
    };
    expect(() => loadConfig(st)).toThrow(/AUTH_PROVIDER=dev/);
    expect(() => loadConfig({ ...st, KORA_ALLOW_DEV_IDP: 'true' })).toThrow(/keys/);
    expect(
      loadConfig({
        ...st,
        KORA_ALLOW_DEV_IDP: 'true',
        KORA_MFA_ENC_KEY: 'k',
        KORA_DEV_IDP_PRIVATE_JWK: '{}',
      }).auth.provider,
    ).toBe('dev');
  });
  it('IRTC R1-11: API docs only in dev and test', () => {
    expect(loadConfig({ ...base, KORA_ENV: 'dev' }).apiDocs).toBe(true);
    expect(loadConfig({ ...base, KORA_ENV: 'test' }).apiDocs).toBe(true);
    expect(
      loadConfig({
        ...base,
        AUTH_PROVIDER: 'keycloak',
        KORA_ENV: 'staging',
        REDIS_URL: 'redis://:p@x',
        KORA_ALLOW_INSECURE_TRANSPORT: 'true',
      }).apiDocs,
    ).toBe(false);
  });
  it('validates scrypt cost', () => {
    expect(() => loadConfig({ ...base, KORA_SCRYPT_N: '1000' })).toThrow(/power of two/);
  });
});
