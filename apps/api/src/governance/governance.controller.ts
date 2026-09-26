import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  GOVERNANCE_ROLES,
  IncidentClassifySchema,
  IncidentCloseSchema,
  IncidentCreateSchema,
  IncidentResolveSchema,
} from '@kora/domain';
import type { Response } from 'express';
import { z } from 'zod';

import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { openApiSchema, ZodValidationPipe } from '../common/zod';
import { DbService } from '../db/db.service';
import { DbDisclosureRegistry } from '../disclosures/db-disclosure-registry';
import { EvidenceService, parseRange, type EvidenceFormat } from './controls/evidence.service';
import { IncidentsService } from './incidents.service';
import { RETENTION_CLASSES, retentionDays, retentionReport } from './retention';

const ControlId = z.string().regex(/^KC-\d{2}$/);
const EvidenceQuery = z.strictObject({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  format: z.enum(['json', 'csv', 'pdf']).default('json'),
});
const IncidentListQuery = z.strictObject({ open: z.enum(['true', 'false']).optional() });

/**
 * Governance (goal 09): the control catalogue, evidence export per control and period, the retention
 * policy, the open regulatory placeholders and the ITIL 4 incident register. 2nd and 3rd line.
 */
@ApiTags('governance')
@Controller('governance')
@Roles(...GOVERNANCE_ROLES)
export class GovernanceController {
  constructor(
    private readonly evidence: EvidenceService,
    private readonly incidents: IncidentsService,
    private readonly db: DbService,
    private readonly disclosures: DbDisclosureRegistry,
  ) {}

  @Get('controls')
  @ApiOperation({ summary: 'The control matrix (COBIT 2019 refs, owner line, frequency, evidence source, test procedure).' })
  controls() {
    return { controls: this.evidence.catalogue() };
  }

  @Get('controls/:id')
  @ApiOperation({ summary: 'One control.' })
  control(@Param('id', new ZodValidationPipe(ControlId)) id: string) {
    return this.evidence.control(id);
  }

  @Get('controls/:id/evidence')
  @ApiOperation({
    summary:
      'Run the control’s automated evidence query for a period [from, to) and export it as JSON, CSV or PDF. Audited (governance.evidence_exported) with the SHA-256 of the file.',
  })
  @ApiQuery({ name: 'from', required: false, description: 'ISO-8601 (default: 30 days before to)' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO-8601, exclusive (default: now)' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv', 'pdf'] })
  async evidenceExport(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ZodValidationPipe(ControlId)) id: string,
    @Query(new ZodValidationPipe(EvidenceQuery)) q: z.infer<typeof EvidenceQuery>,
    @Res() res: Response,
  ) {
    const range = parseRange(q.from, q.to);
    const out = await this.evidence.export(id, range, q.format as EvidenceFormat, p.sub);
    res.setHeader('Content-Type', out.contentType);
    res.setHeader('Content-Disposition', `${q.format === 'json' ? 'inline' : 'attachment'}; filename="${out.filename}"`);
    res.setHeader('X-Kora-Evidence-Sha256', out.sha256);
    res.setHeader('X-Kora-Evidence-Rows', String(out.rows));
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(out.body);
  }

  @Get('retention')
  @ApiOperation({ summary: 'Record retention policy and a dry-run report (periods are placeholders until Compliance sets them, OQ-R4).' })
  async retention() {
    return {
      policy: RETENTION_CLASSES.map((c) => ({ ...c, periodDays: retentionDays(c) })),
      report: await retentionReport(this.db),
      note: 'Dry run: the application never deletes regulated records. Periods set via KORA_RETENTION_<CLASS>_DAYS once Compliance decides.',
    };
  }

  @Get('placeholders')
  @ApiOperation({ summary: 'Regulatory placeholders still open in the disclosures registry, with their owner and open question.' })
  placeholders() {
    return { placeholders: this.disclosures.placeholders() };
  }

  // ------------------------------------------------------------ incidents (ITIL 4)

  @Get('incidents')
  @ApiOperation({ summary: 'Incident register.' })
  @ApiQuery({ name: 'open', required: false })
  listIncidents(@Query(new ZodValidationPipe(IncidentListQuery)) q: z.infer<typeof IncidentListQuery>) {
    return this.incidents.list({ open: q.open === 'true' }).then((incidents) => ({ incidents }));
  }

  @Get('incidents/:id')
  @ApiOperation({ summary: 'One incident.' })
  incident(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.incidents.get(id);
  }

  @Post('incidents')
  @HttpCode(201)
  @Roles('risk_officer', 'admin')
  @ApiOperation({ summary: 'Log an incident (detect → log).' })
  @ApiBody({ schema: openApiSchema(IncidentCreateSchema) })
  createIncident(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(IncidentCreateSchema)) body: z.infer<typeof IncidentCreateSchema>) {
    return this.incidents.create(p.sub, body);
  }

  @Post('incidents/:id/classify')
  @HttpCode(200)
  @Roles('risk_officer', 'admin')
  @ApiOperation({ summary: 'Classify: impact × urgency → priority P1–P4.' })
  @ApiBody({ schema: openApiSchema(IncidentClassifySchema) })
  classify(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(IncidentClassifySchema)) body: z.infer<typeof IncidentClassifySchema>,
  ) {
    return this.incidents.classify(p.sub, id, body);
  }

  @Post('incidents/:id/resolve')
  @HttpCode(200)
  @Roles('risk_officer', 'admin')
  @ApiOperation({ summary: 'Resolve with a resolution note.' })
  @ApiBody({ schema: openApiSchema(IncidentResolveSchema) })
  resolve(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(IncidentResolveSchema)) body: z.infer<typeof IncidentResolveSchema>,
  ) {
    return this.incidents.resolve(p.sub, id, body);
  }

  @Post('incidents/:id/close')
  @HttpCode(200)
  @Roles('risk_officer', 'admin')
  @ApiOperation({ summary: 'Close (P1/P2 need a post-incident review reference).' })
  @ApiBody({ schema: openApiSchema(IncidentCloseSchema) })
  close(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(IncidentCloseSchema)) body: z.infer<typeof IncidentCloseSchema>,
  ) {
    return this.incidents.close(p.sub, id, body);
  }
}
