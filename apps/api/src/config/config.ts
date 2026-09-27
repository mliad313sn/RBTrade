import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  KORA_ENV: z.enum(['dev', 'test', 'staging', 'production']).default('dev'),
  NODE_ENV: z.string().default('development'),
  LIVE_TRADING_ENABLED: bool,
  API_PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  AUTH_PROVIDER: z.enum(['dev', 'keycloak']).default('dev'),
  KORA_JWT_ISSUER: z.string().url().default('http://localhost:4000/auth'),
  KORA_JWT_AUDIENCE: z.string().default('kora-api'),
  KORA_DEV_IDP_PRIVATE_JWK: z.string().optional().default(''),
  KORA_MFA_ENC_KEY: z.string().optional().default(''),
  KORA_SCRYPT_N: z.coerce
    .number()
    .int()
    .refine((n) => n >= 16384 && (n & (n - 1)) === 0, 'KORA_SCRYPT_N must be a power of two >= 16384')
    .default(131072),
  KORA_AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(20),
  KORA_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(1800),
  KEYCLOAK_URL: z.string().url().default('http://localhost:8080'),
  KEYCLOAK_REALM: z.string().default('kora'),
  KEYCLOAK_CLIENT_ID: z.string().default('kora-web'),
  KEYCLOAK_CLIENT_SECRET: z.string().optional().default(''),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Goal 09 data protection: only a local compose stack may skip TLS to Postgres/Redis outside dev/test. */
  KORA_ALLOW_INSECURE_TRANSPORT: bool,
  /** IRTC R1-11: the dev IdP outside dev/test only with this explicit opt-in (never in production). */
  KORA_ALLOW_DEV_IDP: bool,
});

/** True when the Redis URL carries a password (`redis://:pw@host`, `rediss://user:pw@host`). */
export function redisUrlHasPassword(url: string): boolean {
  try {
    return new URL(url).password.length > 0;
  } catch {
    return false;
  }
}

export type AppConfig = ReturnType<typeof loadConfig>;

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const e = parsed.data;
  if (e.LIVE_TRADING_ENABLED) {
    // Paper first: LIVE needs a broker adapter, compliance sign-off record and per-session 2FA (goal 09).
    throw new ConfigError('LIVE_TRADING_ENABLED=true is not supported by this build. KORA runs in PAPER only.');
  }
  const production = e.NODE_ENV === 'production' || e.KORA_ENV === 'production';
  if (e.AUTH_PROVIDER === 'dev' && production) {
    throw new ConfigError('AUTH_PROVIDER=dev must never run in production. Use keycloak.');
  }
  const staging = e.KORA_ENV === 'staging';
  // IRTC R1-11: staging must not silently run the dev IdP (ephemeral keys make every TOTP secret
  // undecryptable after a restart). It needs an explicit opt-in and persistent keys.
  if (e.AUTH_PROVIDER === 'dev' && staging && !e.KORA_ALLOW_DEV_IDP) {
    throw new ConfigError('AUTH_PROVIDER=dev is refused in staging. Use keycloak, or set KORA_ALLOW_DEV_IDP=true for a test stage.');
  }
  if ((production || staging) && (!e.KORA_MFA_ENC_KEY || !e.KORA_DEV_IDP_PRIVATE_JWK) && e.AUTH_PROVIDER === 'dev') {
    throw new ConfigError('Signing and MFA encryption keys must be provided outside dev.');
  }
  // Goal 09 (data protection, encryption in transit): staging and production talk TLS to Postgres
  // and Redis. The escape hatch exists only for a local docker compose stack.
  if ((production || e.KORA_ENV === 'staging') && !e.KORA_ALLOW_INSECURE_TRANSPORT) {
    if (!/[?&]sslmode=(require|verify-ca|verify-full)\b/.test(e.DATABASE_URL))
      throw new ConfigError('DATABASE_URL must use TLS outside dev/test (sslmode=require, verify-ca or verify-full).');
    if (!e.REDIS_URL.startsWith('rediss://')) throw new ConfigError('REDIS_URL must use TLS (rediss://) outside dev/test.');
  }
  // IRTC R1-11: Redis carries the market-data/order WS bus and robot jobs; outside dev/test it must
  // require authentication (TLS alone does not stop anyone who can reach it from injecting frames).
  // The local-compose TLS escape hatch does not waive this: compose sets requirepass too.
  if ((production || staging) && !redisUrlHasPassword(e.REDIS_URL)) {
    throw new ConfigError('REDIS_URL must carry a password outside dev/test (requirepass or an ACL user), e.g. rediss://:<password>@host:6380.');
  }
  const keycloakIssuer = `${e.KEYCLOAK_URL.replace(/\/$/, '')}/realms/${e.KEYCLOAK_REALM}`;
  return {
    env: e.KORA_ENV,
    production,
    tradingEnvironment: 'PAPER' as const,
    liveTradingEnabled: false as const,
    port: e.API_PORT,
    webOrigin: e.WEB_ORIGIN,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    logLevel: e.LOG_LEVEL,
    /** IRTC R1-11: Swagger UI and /openapi.json are served only in dev and test. */
    apiDocs: (e.KORA_ENV === 'dev' || e.KORA_ENV === 'test') && !production,
    auth: {
      provider: e.AUTH_PROVIDER,
      issuer: e.AUTH_PROVIDER === 'dev' ? e.KORA_JWT_ISSUER : keycloakIssuer,
      audience: e.KORA_JWT_AUDIENCE,
      devPrivateJwk: e.KORA_DEV_IDP_PRIVATE_JWK,
      mfaEncKey: e.KORA_MFA_ENC_KEY,
      scryptN: e.KORA_SCRYPT_N,
      rateLimitPerMinute: e.KORA_AUTH_RATE_LIMIT,
      accessTokenTtlSeconds: e.KORA_ACCESS_TOKEN_TTL_SECONDS,
      secureCookies: e.KORA_ENV !== 'dev' && e.KORA_ENV !== 'test',
      keycloak: {
        url: e.KEYCLOAK_URL,
        realm: e.KEYCLOAK_REALM,
        issuer: keycloakIssuer,
        clientId: e.KEYCLOAK_CLIENT_ID,
        clientSecret: e.KEYCLOAK_CLIENT_SECRET,
      },
    },
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
