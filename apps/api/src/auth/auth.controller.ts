import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { z } from 'zod';

import { AuditService } from '../audit/audit.service';
import { authThrottle, signupLimitPerHour } from '../common/auth-throttle';
import { clientIp, type KoraRequest } from '../common/request';
import { openApiSchema, ZodValidationPipe } from '../common/zod';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { LoginSchema, MfaEnrollSchema, MfaRecoverySchema, MfaVerifySchema, RecoveryCodesRegenerateSchema, SignupSchema } from './auth.schemas';
import { clearAccessCookie, setAccessCookie } from './cookies';
import { Public } from './decorators';
import { AuthError, DevIdpService } from './dev-idp.service';
import { SessionsService } from './sessions.service';
import { TokenService } from './token.service';

function mapAuthError(e: unknown, res?: Response): never {
  if (e instanceof AuthError) {
    const body = { error: e.code, message: e.message };
    switch (e.code) {
      case 'email_taken':
      case 'mfa_already_enrolled':
        throw new ConflictException(body);
      case 'too_many_attempts':
        // IRTC R1-04: back-off is keyed on the e-mail string, so this answer is the same for an
        // unknown and an existing account (no enumeration). The body carries no timing detail.
        if (res && e.retryAfterSeconds) res.setHeader('Retry-After', String(e.retryAfterSeconds));
        throw new HttpException({ statusCode: 429, ...body }, HttpStatus.TOO_MANY_REQUESTS);
      case 'mfa_locked':
        throw new ForbiddenException(body);
      default:
        throw new UnauthorizedException(body);
    }
  }
  throw e;
}


@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly idp: DevIdpService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly sessions: SessionsService,
  ) {}

  private assertDevIdp(): void {
    if (this.config.auth.provider !== 'dev') {
      throw new NotFoundException({ error: 'not_found', message: 'Use the OIDC login (/auth/oidc/start)' });
    }
  }

  @Public()
  @Get('.well-known/openid-configuration')
  @ApiOperation({ summary: 'OIDC discovery (dev IdP subset)' })
  discovery() {
    this.assertDevIdp();
    const iss = this.config.auth.issuer;
    return {
      issuer: iss,
      jwks_uri: `${iss}/jwks.json`,
      id_token_signing_alg_values_supported: ['ES256'],
      subject_types_supported: ['public'],
      response_types_supported: ['token'],
      claims_supported: ['sub', 'email', 'realm_access', 'amr'],
      amr_values_supported: ['pwd', 'otp'],
    };
  }

  @Public()
  @Get('jwks.json')
  @ApiOperation({ summary: 'Public signing keys of the dev IdP' })
  jwks() {
    this.assertDevIdp();
    return this.tokens.publicJwks();
  }

  @Public()
  @Throttle({ ...authThrottle(), long: { limit: () => signupLimitPerHour(), ttl: 3_600_000 } })
  @Post('signup')
  @ApiOperation({ summary: 'Create an account. Everyone starts as novice (PAPER); Pro trading needs the appropriateness assessment, then TOTP enrolment at the next login.' })
  @ApiBody({ schema: openApiSchema(SignupSchema) })
  async signup(@Body(new ZodValidationPipe(SignupSchema)) body: z.infer<typeof SignupSchema>, @Req() req: KoraRequest) {
    this.assertDevIdp();
    return this.idp.signup(body, clientIp(req)).catch(mapAuthError);
  }

  @Public()
  @Throttle(authThrottle())
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Password step. Returns ok, mfa_required or mfa_enrollment_required.' })
  @ApiBody({ schema: openApiSchema(LoginSchema) })
  async login(
    @Body(new ZodValidationPipe(LoginSchema)) body: z.infer<typeof LoginSchema>,
    @Req() req: KoraRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.assertDevIdp();
    const out = await this.idp.login(body.email, body.password, clientIp(req)).catch((e: unknown) => mapAuthError(e, res));
    if (out.status === 'ok') setAccessCookie(res, out.accessToken, this.config);
    return out;
  }

  @Public()
  @Throttle(authThrottle())
  @Post('mfa/enroll')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start TOTP enrolment. Returns the otpauth URI and base32 secret.' })
  @ApiBody({ schema: openApiSchema(MfaEnrollSchema) })
  async enroll(@Body(new ZodValidationPipe(MfaEnrollSchema)) body: z.infer<typeof MfaEnrollSchema>) {
    this.assertDevIdp();
    return this.idp.enroll(body.mfaToken).catch(mapAuthError);
  }

  @Public()
  @Throttle(authThrottle())
  @Post('mfa/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verify a TOTP code (completes enrolment on first use) and issue the session.' })
  @ApiBody({ schema: openApiSchema(MfaVerifySchema) })
  async verify(
    @Body(new ZodValidationPipe(MfaVerifySchema)) body: z.infer<typeof MfaVerifySchema>,
    @Req() req: KoraRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.assertDevIdp();
    const out = await this.idp.verify(body.mfaToken, body.code, clientIp(req)).catch(mapAuthError);
    setAccessCookie(res, out.accessToken, this.config);
    return { status: 'ok' as const, ...out };
  }

  @Public()
  @Throttle(authThrottle())
  @Post('mfa/recovery')
  @HttpCode(200)
  @ApiOperation({ summary: 'B-902: second factor with a one-time recovery code (lost authenticator); issues the session.' })
  @ApiBody({ schema: openApiSchema(MfaRecoverySchema) })
  async recovery(
    @Body(new ZodValidationPipe(MfaRecoverySchema)) body: z.infer<typeof MfaRecoverySchema>,
    @Req() req: KoraRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.assertDevIdp();
    const out = await this.idp.recover(body.mfaToken, body.recoveryCode, clientIp(req)).catch(mapAuthError);
    setAccessCookie(res, out.accessToken, this.config);
    return { status: 'ok' as const, ...out };
  }

  @Throttle(authThrottle())
  @Post('mfa/recovery-codes')
  @HttpCode(200)
  @ApiOperation({ summary: 'B-902: replace the recovery codes (needs a fresh 6-digit code); returns them once.' })
  @ApiBody({ schema: openApiSchema(RecoveryCodesRegenerateSchema) })
  async regenerateRecoveryCodes(
    @Body(new ZodValidationPipe(RecoveryCodesRegenerateSchema)) body: z.infer<typeof RecoveryCodesRegenerateSchema>,
    @Req() req: KoraRequest,
  ) {
    this.assertDevIdp();
    const codes = await this.idp.regenerateRecoveryCodes(req.principal!.sub, body.code);
    if (!codes) throw new UnauthorizedException({ error: 'invalid_code', message: 'That code is not valid. Check your authenticator app and try again.' });
    return { recoveryCodes: codes };
  }

  @Get('mfa/recovery-codes')
  @ApiOperation({ summary: 'B-902: how many unused recovery codes the signed-in user has left.' })
  async recoveryCodesStatus(@Req() req: KoraRequest) {
    this.assertDevIdp();
    return { remaining: await this.idp.recoveryCodesRemaining(req.principal!.sub) };
  }

  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ summary: 'End the session: clears the cookie and revokes the token server side (goal 10).' })
  async logout(@Req() req: KoraRequest, @Res({ passthrough: true }) res: Response) {
    clearAccessCookie(res, this.config);
    const p = req.principal!;
    await this.sessions.revoke(p, 'logout');
    await this.audit.record({ actorId: p.sub, actorType: 'user', action: 'auth.logout', entity: 'user', entityId: p.sub, payload: {} });
    return { status: 'ok' };
  }
}
