import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AttemptSchema, GOVERNANCE_ROLES, type AttemptRequest } from '@kora/domain';
import { z } from 'zod';

import { AuditService } from '../audit/audit.service';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { openApiSchema, ZodValidationPipe } from '../common/zod';
import { DbService } from '../db/db.service';
import { DisclosureAcknowledgements } from '../disclosures/acknowledgements.service';
import { DbDisclosureRegistry } from '../disclosures/db-disclosure-registry';
import { definitionChecksum, DisclosureDefinitionSchema } from '../disclosures/disclosure-render';
import { DISCLOSURE_LOCALES, type DisclosureLocale } from '../disclosures/disclosure.types';
import { GOVERNANCE_CONFIG, type GovernanceConfig } from '../governance/governance-config';
import { bestExecution } from '../governance/controls/evidence-queries';
import { parseRange } from '../governance/controls/evidence.service';
import { KYC_PROVIDER, KycNotConfiguredError, type KycProvider } from './kyc';
import { SubjectAccessService } from './subject-access.service';
import { SuitabilityService } from './suitability.service';

const DisclosureId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const AckQuery = z.strictObject({ userId: z.uuid(), disclosureId: DisclosureId.optional() });
const AtQuery = z.strictObject({
  at: z.iso.datetime({ offset: true }).optional(),
  locale: z.enum(DISCLOSURE_LOCALES).optional(),
  jurisdiction: z
    .string()
    .regex(/^([A-Z]{2}|GLOBAL)$/)
    .optional(),
});
const DraftSchema = z.strictObject({
  jurisdiction: z.string().regex(/^([A-Z]{2}|GLOBAL)$/),
  definition: DisclosureDefinitionSchema,
});
const BestExQuery = z.strictObject({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  groupBy: z.enum(['instrument', 'hour']).default('instrument'),
});

/**
 * Compliance hooks (goal 09) for the 2nd and 3rd line: acknowledgement history with the exact
 * document in force at each acknowledgement, the disclosures registry (versions, drafts, text in force
 * at a time), suitability profiles, the KYC stub, best-execution data and subject-access exports.
 * Regulatory values stay placeholders until Compliance publishes them through four-eyes.
 */
@ApiTags('compliance')
@Controller('compliance')
@Roles(...GOVERNANCE_ROLES)
export class ComplianceController {
  constructor(
    @Inject(GOVERNANCE_CONFIG) private readonly cfg: GovernanceConfig,
    @Inject(KYC_PROVIDER) private readonly kyc: KycProvider,
    private readonly acks: DisclosureAcknowledgements,
    private readonly registry: DbDisclosureRegistry,
    private readonly suitability: SuitabilityService,
    private readonly subjectAccess: SubjectAccessService,
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  @Get('acknowledgements')
  @ApiOperation({
    summary:
      'A user’s acknowledgements, each with the disclosure version in force when it was given, re-rendered from the registry and verified by content hash.',
  })
  async acknowledgements(@Query(new ZodValidationPipe(AckQuery)) q: z.infer<typeof AckQuery>) {
    return {
      userId: q.userId,
      acknowledgements: await this.acks.history(q.userId, q.disclosureId),
    };
  }

  @Get('disclosures/:id/versions')
  @ApiOperation({
    summary:
      'Every published version of a disclosure (per jurisdiction, with effective dates) and pending drafts.',
  })
  async versions(@Param('id', new ZodValidationPipe(DisclosureId)) id: string) {
    const drafts = await this.db.query<{
      version: string;
      jurisdiction: string;
      drafted_by: string;
      drafted_at: Date;
    }>(
      `SELECT version, jurisdiction, drafted_by, drafted_at FROM disclosure_documents WHERE id = $1 AND status = 'draft' ORDER BY drafted_at DESC`,
      [id],
    );
    return {
      id,
      deploymentJurisdiction: this.cfg.jurisdiction,
      published: this.registry.history(id),
      drafts: drafts.map((d) => ({
        version: d.version,
        jurisdiction: d.jurisdiction,
        draftedBy: d.drafted_by,
        draftedAt: d.drafted_at.toISOString(),
      })),
    };
  }

  @Get('disclosures/:id/at')
  @ApiOperation({
    summary: 'The disclosure text and values in force at a point in time (default now).',
  })
  at(
    @Param('id', new ZodValidationPipe(DisclosureId)) id: string,
    @Query(new ZodValidationPipe(AtQuery)) q: z.infer<typeof AtQuery>,
  ) {
    const when = q.at ? Date.parse(q.at) : Date.now();
    const doc = this.registry.at(id, (q.locale ?? 'en') as DisclosureLocale, when, q.jurisdiction);
    if (!doc)
      throw new NotFoundException({
        error: 'not_found',
        message: 'No version of this disclosure was in force then.',
      });
    return { at: new Date(when).toISOString(), document: doc };
  }

  @Post('disclosures/drafts')
  @HttpCode(201)
  @Roles('risk_officer', 'admin')
  @ApiOperation({
    summary:
      'Draft a new disclosure version (text in EN and FR, value keys). Publishing needs a four-eyes request (kind disclosure_publish) approved by someone else.',
  })
  @ApiBody({ schema: openApiSchema(DraftSchema) })
  async draft(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(DraftSchema)) body: z.infer<typeof DraftSchema>,
  ) {
    const d = body.definition;
    const exists = await this.db.query(
      'SELECT 1 FROM disclosure_documents WHERE id = $1 AND version = $2 AND jurisdiction = $3',
      [d.id, d.version, body.jurisdiction],
    );
    if (exists.length)
      throw new ConflictException({
        error: 'version_exists',
        message: 'This version already exists; use a new version number.',
      });
    return this.db.tx(async (c) => {
      await c.query(
        `INSERT INTO disclosure_documents (id, version, jurisdiction, locales, value_keys, simulated, review_status, checksum, status, drafted_by)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, 'draft', $9)`,
        [
          d.id,
          d.version,
          body.jurisdiction,
          JSON.stringify(d.locales),
          d.values,
          d.simulated,
          d.reviewStatus,
          definitionChecksum(d),
          p.sub,
        ],
      );
      await this.audit.record(
        {
          actorId: p.sub,
          actorType: 'user',
          action: 'disclosure.drafted',
          entity: 'disclosure',
          entityId: d.id,
          payload: {
            disclosureId: d.id,
            version: d.version,
            jurisdiction: body.jurisdiction,
            checksum: definitionChecksum(d),
            values: d.values,
          },
        },
        c,
      );
      return {
        id: d.id,
        version: d.version,
        jurisdiction: body.jurisdiction,
        status: 'draft',
        checksum: definitionChecksum(d),
      };
    });
  }

  @Get('suitability/:userId')
  @ApiOperation({
    summary:
      'A user’s appropriateness / knowledge / suitability profile (scores only; not advice).',
  })
  suitabilityProfile(@Param('userId', new ParseUUIDPipe()) userId: string) {
    return this.suitability.profile(userId);
  }

  @Get('kyc/providers')
  @ApiOperation({ summary: 'KYC provider interface: stub only (OQ-K1).' })
  kycProviders() {
    return { providers: [this.kyc.describe()] };
  }

  @Get('best-execution')
  @ApiOperation({
    summary:
      'Best-execution report data: slippage vs the reference price by instrument or UTC hour.',
  })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'groupBy', required: false, enum: ['instrument', 'hour'] })
  async bestExecution(@Query(new ZodValidationPipe(BestExQuery)) q: z.infer<typeof BestExQuery>) {
    const r = parseRange(q.from, q.to);
    return {
      from: r.from.toISOString(),
      to: r.to.toISOString(),
      groupBy: q.groupBy,
      simulated: true,
      definition:
        'slippage = (fill price − reference price at decision) × side sign; positive = adverse; bps vs the reference price',
      rows: await bestExecution(this.db, r.from, r.to, q.groupBy),
    };
  }

  @Get('subject-access/:userId')
  @Roles('risk_officer', 'admin')
  @ApiOperation({ summary: 'Subject-access export on behalf of a user (audited).' })
  subjectAccessExport(
    @CurrentPrincipal() p: Principal,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ) {
    return this.subjectAccess.export(userId, p.sub);
  }
}

/** The signed-in user’s own compliance records (goal 09). */
@ApiTags('compliance')
@Controller('me')
export class MeComplianceController {
  constructor(
    @Inject(KYC_PROVIDER) private readonly kyc: KycProvider,
    private readonly acks: DisclosureAcknowledgements,
    private readonly suitability: SuitabilityService,
    private readonly subjectAccess: SubjectAccessService,
  ) {}

  @Get('acknowledgements')
  @ApiOperation({
    summary: 'Your acknowledgements, each with the exact text you acknowledged (verified).',
  })
  async acknowledgements(@CurrentPrincipal() p: Principal) {
    return { acknowledgements: await this.acks.history(p.sub) };
  }

  @Get('suitability')
  @ApiOperation({
    summary:
      'Your profile from the appropriateness, knowledge and suitability questionnaires (not advice).',
  })
  profile(@CurrentPrincipal() p: Principal) {
    return this.suitability.profile(p.sub);
  }

  @Get('kyc')
  @ApiOperation({ summary: 'Your KYC status (stub: not configured).' })
  kycStatus(@CurrentPrincipal() p: Principal) {
    return this.kyc.status(p.sub);
  }

  @Post('kyc')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start a KYC check (stub: always refused, nothing is sent).' })
  async kycStart(@CurrentPrincipal() p: Principal) {
    try {
      return await this.kyc.start({ userId: p.sub, jurisdiction: 'GLOBAL' });
    } catch (e) {
      if (e instanceof KycNotConfiguredError)
        throw new ServiceUnavailableException({ error: 'kyc_not_configured', message: e.message });
      throw e;
    }
  }

  @Get('data-export')
  @ApiOperation({
    summary: 'Download everything KORA holds about you (subject access, JSON; audited).',
  })
  dataExport(@CurrentPrincipal() p: Principal) {
    return this.subjectAccess.export(p.sub, p.sub);
  }
}

/** Suitability questionnaire (goal 09) for any signed-in user. */
@ApiTags('compliance')
@Controller('suitability')
export class SuitabilityController {
  constructor(private readonly suitability: SuitabilityService) {}

  @Get('questionnaire')
  @ApiOperation({
    summary:
      'The suitability questionnaire (SIMULATED placeholder content, OQ-C2; no answer weights).',
  })
  questionnaire() {
    return this.suitability.questionnaire();
  }

  @Post('attempts')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Submit answers; only the score and band are kept. The result is a profile, not a recommendation.',
  })
  @ApiBody({ schema: openApiSchema(AttemptSchema) })
  submit(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(AttemptSchema)) body: AttemptRequest,
  ) {
    return this.suitability.submit(p.sub, body);
  }
}
