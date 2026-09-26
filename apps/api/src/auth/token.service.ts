import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { isRole, type Role } from '@kora/domain';
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  SignJWT,
  type CryptoKey,
  type JWK,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';

import { APP_CONFIG, type AppConfig } from '../config/config';
import type { Principal } from './principal';

export const MFA_AUDIENCE = 'kora-mfa';
const ALG = 'ES256';

export interface AccessClaims {
  sub: string;
  email: string;
  roles: Role[];
  amr: string[];
}

export class InvalidTokenError extends Error {}

/**
 * Issues (dev IdP) and verifies (both IdPs) JWTs. Verification always goes through a JWKS so the
 * dev and Keycloak paths share code (ADR 0101).
 */
@Injectable()
export class TokenService implements OnModuleInit {
  private readonly log = new Logger(TokenService.name);
  private privateKey?: CryptoKey;
  private publicJwk?: JWK;
  private jwks!: JWTVerifyGetKey;
  private initialised = false;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async onModuleInit(): Promise<void> {
    await this.init();
  }

  async init(): Promise<void> {
    if (this.initialised) return;
    this.initialised = true;
    if (this.config.auth.provider === 'keycloak') {
      this.jwks = createRemoteJWKSet(
        new URL(`${this.config.auth.keycloak.issuer}/protocol/openid-connect/certs`),
      );
      return;
    }
    let privateJwk: JWK;
    if (this.config.auth.devPrivateJwk) {
      privateJwk = JSON.parse(this.config.auth.devPrivateJwk) as JWK;
    } else {
      this.log.warn('KORA_DEV_IDP_PRIVATE_JWK not set: using an ephemeral signing key (dev only)');
      const { privateKey } = await generateKeyPair(ALG, { extractable: true });
      privateJwk = await exportJWK(privateKey);
    }
    const kid = privateJwk.kid ?? 'kora-dev-1';
    this.privateKey = (await importJWK({ ...privateJwk, alg: ALG }, ALG)) as CryptoKey;
    const { d: _d, ...pub } = privateJwk;
    this.publicJwk = { ...pub, kid, alg: ALG, use: 'sig' };
    this.jwks = createLocalJWKSet({ keys: [this.publicJwk] });
  }

  publicJwks(): { keys: JWK[] } {
    return { keys: this.publicJwk ? [this.publicJwk] : [] };
  }

  private signer(payload: JWTPayload, audience: string, ttlSeconds: number): SignJWT {
    if (!this.privateKey || !this.publicJwk) throw new Error('Token signing is only available with AUTH_PROVIDER=dev');
    return new SignJWT(payload)
      .setProtectedHeader({ alg: ALG, kid: this.publicJwk.kid!, typ: 'JWT' })
      .setIssuer(this.config.auth.issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setJti(randomUUID())
      .setExpirationTime(`${ttlSeconds}s`);
  }

  async issueAccessToken(c: AccessClaims): Promise<string> {
    return this.signer(
      { sub: c.sub, email: c.email, realm_access: { roles: c.roles }, amr: c.amr, azp: 'kora-web' },
      this.config.auth.audience,
      this.config.auth.accessTokenTtlSeconds,
    )
      .setSubject(c.sub)
      .sign(this.privateKey!);
  }

  /** Short-lived token that only unlocks the MFA step. Never accepted as an access token. */
  async issueMfaToken(sub: string, stage: 'verify' | 'enroll'): Promise<string> {
    return this.signer({ purpose: 'mfa', stage, amr: ['pwd'] }, MFA_AUDIENCE, 300)
      .setSubject(sub)
      .sign(this.privateKey!);
  }

  async verifyMfaToken(token: string): Promise<{ sub: string; stage: 'verify' | 'enroll' }> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.config.auth.issuer,
        audience: MFA_AUDIENCE,
        algorithms: [ALG],
      });
      if (payload.purpose !== 'mfa' || !payload.sub) throw new InvalidTokenError('not an mfa token');
      return { sub: payload.sub, stage: payload.stage === 'enroll' ? 'enroll' : 'verify' };
    } catch (e) {
      throw new InvalidTokenError((e as Error).message);
    }
  }

  async verifyAccessToken(token: string): Promise<Principal> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, {
        issuer: this.config.auth.issuer,
        audience: this.config.auth.audience,
        algorithms: this.config.auth.provider === 'dev' ? [ALG] : ['RS256', 'ES256'],
      }));
    } catch (e) {
      throw new InvalidTokenError((e as Error).message);
    }
    if (payload.purpose !== undefined || !payload.sub) throw new InvalidTokenError('not an access token');
    const realm = payload.realm_access as { roles?: unknown } | undefined;
    const roles = Array.isArray(realm?.roles) ? realm.roles.filter(isRole) : [];
    const amr = Array.isArray(payload.amr) ? (payload.amr as unknown[]).map(String) : [];
    return {
      sub: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : null,
      roles,
      mfa: amr.includes('otp') || amr.includes('mfa'),
      tokenId: typeof payload.jti === 'string' ? payload.jti : null,
    };
  }
}
