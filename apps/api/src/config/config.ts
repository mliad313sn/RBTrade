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
});

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
  if (production && (!e.KORA_MFA_ENC_KEY || !e.KORA_DEV_IDP_PRIVATE_JWK) && e.AUTH_PROVIDER === 'dev') {
    throw new ConfigError('Signing and MFA encryption keys must be provided outside dev.');
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
