import {
  ConflictException,
  Controller,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { AuthError, DevIdpService } from '../auth/dev-idp.service';
import { CurrentPrincipal } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { TokenService } from '../auth/token.service';
import { UsersRepository } from '../auth/users.repository';
import { APP_CONFIG, type AppConfig } from '../config/config';

/**
 * B-017: optional two-step sign-in for novice accounts (MFA is mandatory only for non-novice roles).
 * A signed-in user without MFA gets an enrolment token and a TOTP secret; `POST /auth/mfa/verify`
 * with a code completes enrolment and issues a session with `amr: otp` (existing endpoint). From
 * then on every login asks for a code.
 */
@ApiTags('auth')
@Controller('auth/mfa')
export class MfaOptInController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly tokens: TokenService,
    private readonly idp: DevIdpService,
    private readonly users: UsersRepository,
  ) {}

  @Post('opt-in')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Start optional TOTP enrolment for the signed-in user (novices). Returns the secret, otpauth URI and an enrolment token for POST /auth/mfa/verify.',
  })
  async optIn(@CurrentPrincipal() p: Principal) {
    if (this.config.auth.provider !== 'dev')
      throw new NotFoundException({
        error: 'not_found',
        message: 'Set up two-step sign-in in your identity provider account.',
      });
    const mfa = await this.users.mfa(p.sub);
    if (mfa?.enabled_at)
      throw new ConflictException({
        error: 'mfa_already_enrolled',
        message: 'Two-step sign-in is already on for this account.',
      });
    const mfaToken = await this.tokens.issueMfaToken(p.sub, 'enroll');
    try {
      const enr = await this.idp.enroll(mfaToken);
      return { mfaToken, secret: enr.secret, otpauthUrl: enr.otpauthUrl };
    } catch (e) {
      if (e instanceof AuthError && e.code === 'mfa_already_enrolled')
        throw new ConflictException({ error: e.code, message: e.message });
      throw e;
    }
  }
}
