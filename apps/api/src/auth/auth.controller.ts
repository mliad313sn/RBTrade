import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
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
import { clientIp, type KoraRequest } from '../common/request';
import { openApiSchema, ZodValidationPipe } from '../common/zod';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { LoginSchema, MfaEnrollSchema, MfaVerifySchema, SignupSchema } from './auth.schemas';
import { clearAccessCookie, setAccessCookie } from './cookies';
import { Public } from './decorators';
import { AuthError, DevIdpService } from './dev-idp.service';
import { TokenService } from './token.service';

function mapAuthError(e: unknown): never {
  if (e instanceof AuthError) {
    const body = { error: e.code, message: e.message };
    switch (e.code) {
      case 'email_taken':
      case 'mfa_already_enrolled':
        throw new ConflictException(body);
      case 'locked':
        throw new ForbiddenException(body);
      default:
        throw new UnauthorizedException(body);
    }
  }
  throw e;
}

const authThrottle = () => ({ default: { limit: Number(process.env.KORA_AUTH_RATE_LIMIT ?? 20), ttl: 60_000 } });

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly idp: DevIdpService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
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
  @Throttle(authThrottle())
  @Post('signup')
  @ApiOperation({ summary: 'Create an account (novice or trader; PAPER only). Trader requires MFA enrolment at first login.' })
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
    const out = await this.idp.login(body.email, body.password, clientIp(req)).catch(mapAuthError);
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

  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ summary: 'Clear the session cookie' })
  async logout(@Req() req: KoraRequest, @Res({ passthrough: true }) res: Response) {
    clearAccessCookie(res, this.config);
    const p = req.principal!;
    await this.audit.record({ actorId: p.sub, actorType: 'user', action: 'auth.logout', entity: 'user', entityId: p.sub, payload: {} });
    return { status: 'ok' };
  }
}
