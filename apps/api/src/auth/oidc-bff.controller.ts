import { createHash, randomBytes } from 'node:crypto';

import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';

import type { KoraRequest } from '../common/request';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { setAccessCookie } from './cookies';
import { Public } from './decorators';
import { TokenService } from './token.service';

const OIDC_COOKIE = 'kora_oidc';

/**
 * Backend-for-frontend OIDC authorization-code + PKCE flow against Keycloak (AUTH_PROVIDER=keycloak).
 * Implemented per ADR 0101 but only exercised with a running Keycloak (BACKLOG B-001).
 */
@ApiExcludeController()
@Controller('auth/oidc')
export class OidcBffController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly tokens: TokenService,
  ) {}

  private kc() {
    if (this.config.auth.provider !== 'keycloak') throw new NotFoundException();
    return this.config.auth.keycloak;
  }

  private redirectUri(): string {
    return `${this.config.webOrigin}/api/auth/oidc/callback`;
  }

  @Public()
  @Get('start')
  start(@Res() res: Response): void {
    const kc = this.kc();
    const state = randomBytes(16).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    res.cookie(OIDC_COOKIE, JSON.stringify({ state, verifier }), {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.auth.secureCookies,
      path: '/',
      maxAge: 5 * 60 * 1000,
    });
    const url = new URL(`${kc.issuer}/protocol/openid-connect/auth`);
    url.search = new URLSearchParams({
      client_id: kc.clientId,
      response_type: 'code',
      scope: 'openid email',
      redirect_uri: this.redirectUri(),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    res.redirect(302, url.toString());
  }

  @Public()
  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Req() req: KoraRequest,
    @Res() res: Response,
  ): Promise<void> {
    const kc = this.kc();
    let saved: { state?: string; verifier?: string } = {};
    try {
      saved = JSON.parse(req.cookies[OIDC_COOKIE] ?? '{}') as typeof saved;
    } catch {
      /* fallthrough */
    }
    res.clearCookie(OIDC_COOKIE, { path: '/' });
    if (!code || !state || !saved.state || state !== saved.state || !saved.verifier) {
      throw new BadRequestException({
        error: 'oidc_state',
        message: 'Login expired. Please start again.',
      });
    }
    const tokenRes = await fetch(`${kc.issuer}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri(),
        client_id: kc.clientId,
        client_secret: kc.clientSecret,
        code_verifier: saved.verifier,
      }),
    });
    if (!tokenRes.ok)
      throw new BadRequestException({ error: 'oidc_exchange', message: 'Login failed' });
    const body = (await tokenRes.json()) as { access_token?: string };
    if (!body.access_token)
      throw new BadRequestException({ error: 'oidc_exchange', message: 'Login failed' });
    await this.tokens.verifyAccessToken(body.access_token); // issuer, audience, signature
    setAccessCookie(res, body.access_token, this.config);
    // Same-site hop so the SameSite=Strict cookie is sent on the next navigation.
    res
      .type('html')
      .send(
        '<!doctype html><meta http-equiv="refresh" content="0;url=/"><title>Signing in…</title>',
      );
  }
}
