import { isRole, requiresMfa, type Role } from '@kora/domain';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface EdgeSession {
  sub: string;
  roles: Role[];
  mfa: boolean;
}

let jwks: JWTVerifyGetKey | null = null;
let jwksUrl = '';

function config() {
  const provider = process.env.AUTH_PROVIDER ?? 'dev';
  const apiUrl = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';
  const kcIssuer = `${(process.env.KEYCLOAK_URL ?? 'http://localhost:8080').replace(/\/$/, '')}/realms/${process.env.KEYCLOAK_REALM ?? 'kora'}`;
  return {
    issuer:
      provider === 'keycloak'
        ? kcIssuer
        : (process.env.KORA_JWT_ISSUER ?? 'http://localhost:4000/auth'),
    audience: process.env.KORA_JWT_AUDIENCE ?? 'kora-api',
    jwksUrl:
      process.env.KORA_JWKS_URL ??
      (provider === 'keycloak'
        ? `${kcIssuer}/protocol/openid-connect/certs`
        : `${apiUrl}/auth/jwks.json`),
  };
}

/** Verifies the session cookie in middleware (edge). Same claims contract as the API (ADR 0101). */
export async function verifySession(token: string | undefined): Promise<EdgeSession | null> {
  if (!token) return null;
  const c = config();
  if (!jwks || jwksUrl !== c.jwksUrl) {
    jwks = createRemoteJWKSet(new URL(c.jwksUrl), { cooldownDuration: 5_000 });
    jwksUrl = c.jwksUrl;
  }
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: c.issuer, audience: c.audience });
    if (payload.purpose !== undefined || !payload.sub) return null;
    const realm = payload.realm_access as { roles?: unknown } | undefined;
    const roles = Array.isArray(realm?.roles) ? realm.roles.filter(isRole) : [];
    const amr = Array.isArray(payload.amr) ? payload.amr.map(String) : [];
    const mfa = amr.includes('otp') || amr.includes('mfa');
    if (requiresMfa(roles) && !mfa) return null;
    return { sub: payload.sub, roles, mfa };
  } catch {
    return null;
  }
}
