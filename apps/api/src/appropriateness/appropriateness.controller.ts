import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Post,
  Res,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AttemptSchema, type AttemptRequest } from '@kora/domain';
import type { Response } from 'express';

import { AuditService } from '../audit/audit.service';
import { clearAccessCookie } from '../auth/cookies';
import { CurrentPrincipal } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { UsersRepository } from '../auth/users.repository';
import { openApiSchema, ZodValidationPipe } from '../common/zod';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { DbService } from '../db/db.service';
import { DisclosureAcknowledgements } from '../disclosures/acknowledgements.service';
import { DISCLOSURE_LOCALES, RISK_WARNING_DISCLOSURE_ID, type DisclosureLocale } from '../disclosures/disclosure.types';
import { QuestionnaireService } from './questionnaire.service';

const ID = 'appropriateness';
const attemptThrottle = () => ({ default: { limit: 20, ttl: 60_000 } });

/**
 * Appropriateness assessment (B-018, Sponsor decision OQ-S2). Everyone signs up as `novice`;
 * passing grants `trader`, and the next login enforces TOTP enrolment (MFA rule for non-novice
 * roles). Answers are graded server-side and never stored; the attempt keeps version and score.
 */
@ApiTags('appropriateness')
@Controller('appropriateness')
export class AppropriatenessController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly users: UsersRepository,
    private readonly audit: AuditService,
    private readonly q: QuestionnaireService,
    private readonly acks: DisclosureAcknowledgements,
  ) {}

  private def() {
    void this.q.ensureSynced().catch(() => undefined);
    const d = this.q.get(ID);
    if (!d)
      throw new NotFoundException({
        error: 'not_found',
        message: 'No appropriateness questionnaire is published.',
      });
    return d;
  }

  @Get('questionnaire')
  @ApiOperation({
    summary:
      'The active appropriateness questionnaire (no answer key) and your status: eligible, passed, cool-down.',
  })
  async questionnaire(@CurrentPrincipal() p: Principal) {
    const def = this.def();
    const roles = await this.users.roles(p.sub);
    const last = await this.q.lastAttempt(p.sub, ID);
    const cooldownUntil = this.q.cooldownUntil(def, last);
    const isTrader = roles.includes('trader');
    return {
      questionnaire: this.q.view(def),
      status: {
        hasTraderRole: isTrader,
        eligible: !isTrader && !cooldownUntil,
        cooldownUntil: cooldownUntil?.toISOString() ?? null,
        lastAttempt: last
          ? {
              version: last.version,
              scorePct: last.score_pct,
              passed: last.passed,
              at: last.created_at.toISOString(),
            }
          : null,
      },
    };
  }

  @Post('attempts')
  @HttpCode(200)
  @Throttle(attemptThrottle())
  @ApiOperation({
    summary:
      'Submit answers. Server-graded against the pass mark; a fail starts a cool-down; a pass grants the trader role and signs you out so the next login sets up two-factor authentication. Audited with version and score.',
  })
  @ApiBody({ schema: openApiSchema(AttemptSchema) })
  async attempt(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(AttemptSchema)) body: AttemptRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const def = this.def();
    if (body.questionnaireId !== def.id || body.version !== def.version) {
      throw new ConflictException({
        error: 'questionnaire_version_changed',
        message: 'The questionnaire has changed. Reload it and answer again.',
        current: { id: def.id, version: def.version },
      });
    }
    // IRTC R4-09: the attempt carries the risk warning the user confirmed; it must be the text in force.
    if (!body.riskWarning)
      throw new BadRequestException({
        error: 'risk_warning_required',
        message: 'Read and confirm the risk warning on this page before submitting.',
      });
    const locale = body.riskWarning.locale as DisclosureLocale;
    if (!(DISCLOSURE_LOCALES as readonly string[]).includes(locale))
      throw new BadRequestException({ error: 'invalid_locale', message: 'Unknown locale for the risk warning.' });
    const warning = this.acks.document(RISK_WARNING_DISCLOSURE_ID, locale);
    if (warning.version !== body.riskWarning.version || warning.contentHash !== body.riskWarning.contentHash)
      throw new ConflictException({
        error: 'disclosure_changed',
        message: 'The risk warning has changed since you opened this page. Read the new version and confirm again.',
        current: { version: warning.version, contentHash: warning.contentHash },
      });
    const g = this.q.grade(def, body.answers);
    if (g.missing.length || g.unknown.length) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'incomplete',
        message: 'Answer every question with one of its options.',
        missing: g.missing,
        unknown: g.unknown,
      });
    }
    await this.q.ensureSynced();
    const out = await this.db.tx(async (c) => {
      await c.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [p.sub]); // one attempt at a time per user
      const roles = await this.users.roles(p.sub, c);
      if (roles.includes('trader'))
        throw new ConflictException({
          error: 'already_trader',
          message: 'Your account already has Pro trading access.',
        });
      const until = this.q.cooldownUntil(def, await this.q.lastAttempt(p.sub, ID, c));
      if (until) {
        throw new HttpException(
          {
            statusCode: 429,
            error: 'cooldown',
            message: `You can try again after ${until.toISOString()}.`,
            cooldownUntil: until.toISOString(),
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      const attempt = await this.q.record(c, p.sub, def, g);
      const common = {
        questionnaireId: def.id,
        version: def.version,
        score: g.score,
        maxScore: g.maxScore,
        scorePct: g.scorePct,
        passMarkPct: g.passMarkPct,
        simulatedQuestions: def.simulated,
        attemptId: attempt.id,
      };
      if (!g.passed) {
        const cooldownUntil = this.q.cooldownUntil(def, attempt);
        await this.audit.record(
          {
            actorId: p.sub,
            actorType: 'user',
            action: 'appropriateness.failed',
            entity: 'user',
            entityId: p.sub,
            payload: { ...common, cooldownUntil: cooldownUntil?.toISOString() ?? null },
          },
          c,
        );
        return { passed: false as const, cooldownUntil };
      }
      await c.query(
        `INSERT INTO user_roles (user_id, role, granted_by) VALUES ($1, 'trader', NULL) ON CONFLICT DO NOTHING`,
        [p.sub],
      );
      // IRTC R4-09: the new trader's acknowledgement of the risk warning, in the same transaction.
      await this.acks.record(
        p.sub,
        RISK_WARNING_DISCLOSURE_ID,
        { version: warning.version, contentHash: warning.contentHash, locale, context: 'appropriateness' },
        c,
      );
      // Unlocking Pro switches the default view to Pro (the user can switch back; guardrails follow the view).
      await c.query(
        `INSERT INTO user_preferences (user_id, view_mode) VALUES ($1, 'pro') ON CONFLICT (user_id) DO UPDATE SET view_mode = 'pro', updated_at = now()`,
        [p.sub],
      );
      await this.audit.record(
        {
          actorId: p.sub,
          actorType: 'user',
          action: 'appropriateness.passed',
          entity: 'user',
          entityId: p.sub,
          payload: {
            ...common,
            roleGranted: 'trader',
            viewMode: 'pro',
            mfaEnrolmentRequiredAtNextLogin: true,
          },
        },
        c,
      );
      return { passed: true as const, cooldownUntil: null };
    });
    if (out.passed) clearAccessCookie(res, this.config);
    return {
      passed: out.passed,
      scorePct: g.scorePct,
      passMarkPct: g.passMarkPct,
      questionnaire: { id: def.id, version: def.version },
      ...(out.passed
        ? {
            roleGranted: 'trader',
            next: 'sign_in_again',
            message: 'Pro trading unlocked. Sign in again to set up two-factor authentication.',
          }
        : {
            cooldownUntil: out.cooldownUntil?.toISOString() ?? null,
            topicsToReview: g.topicsToReview,
            message: 'Not passed this time. Review the topics below before trying again.',
          }),
    };
  }
}
