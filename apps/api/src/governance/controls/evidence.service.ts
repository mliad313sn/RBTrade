import { createHash } from 'node:crypto';

import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { DbService } from '../../db/db.service';
import { AnchorsService } from '../anchors.service';
import { toCsv } from '../export/csv';
import { renderPdf, tableLines, type PdfLine } from '../export/pdf';
import { AREA_LABELS, CONTROLS, controlById, type ControlDefinition } from './catalogue';
import { EVIDENCE, type EvidenceTable, type Range } from './evidence-queries';

export type EvidenceFormat = 'json' | 'csv' | 'pdf';

export interface EvidenceResult {
  control: ControlDefinition;
  range: { from: string; to: string };
  generatedAt: string;
  generatedBy: string;
  evidence: EvidenceTable;
}

const MAX_RANGE_MS = 366 * 86_400_000;

export function parseRange(from?: string, to?: string, now = Date.now()): Range {
  const t = to ? new Date(to) : new Date(now);
  const f = from ? new Date(from) : new Date(t.getTime() - 30 * 86_400_000);
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime()))
    throw new BadRequestException({
      error: 'invalid_range',
      message: 'from and to must be ISO-8601 dates.',
    });
  if (f >= t)
    throw new BadRequestException({ error: 'invalid_range', message: 'from must be before to.' });
  if (t.getTime() - f.getTime() > MAX_RANGE_MS)
    throw new BadRequestException({
      error: 'invalid_range',
      message: 'The period can be at most 366 days.',
    });
  return { from: f, to: t };
}

/**
 * Evidence export per control and period (goal 09): runs the control's implemented evidence query
 * and renders it as JSON, CSV or PDF. Every export is audited with the SHA-256 of the file.
 */
@Injectable()
export class EvidenceService {
  constructor(
    @Inject(APP_CONFIG) private readonly app: AppConfig,
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly anchors: AnchorsService,
  ) {}

  catalogue() {
    return CONTROLS.map((c) => ({
      ...c,
      areaLabel: AREA_LABELS[c.area],
      evidenceImplemented: !!EVIDENCE[c.id],
    }));
  }

  control(id: string): ControlDefinition {
    const c = controlById(id);
    if (!c) throw new NotFoundException({ error: 'not_found', message: `No control ${id}.` });
    return c;
  }

  async run(id: string, range: Range, actor: string): Promise<EvidenceResult> {
    const control = this.control(id);
    const q = EVIDENCE[id];
    if (!q)
      throw new NotFoundException({
        error: 'not_implemented',
        message: `No evidence query for ${id}.`,
      });
    const evidence = await q(
      {
        db: this.db,
        verifyChain: () => this.audit.verify(),
        anchors: this.anchors,
        liveTradingEnabled: this.app.liveTradingEnabled,
        env: process.env,
      },
      range,
    );
    return {
      control,
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      generatedAt: new Date().toISOString(),
      generatedBy: actor,
      evidence,
    };
  }

  render(
    r: EvidenceResult,
    format: EvidenceFormat,
  ): { body: Buffer; contentType: string; filename: string } {
    const base = `kora-evidence_${r.control.id}_${r.range.from.slice(0, 10)}_${r.range.to.slice(0, 10)}`;
    if (format === 'csv')
      return {
        body: Buffer.from(toCsv(r.evidence.columns, r.evidence.rows), 'utf8'),
        contentType: 'text/csv; charset=utf-8',
        filename: `${base}.csv`,
      };
    if (format === 'pdf')
      return { body: this.pdf(r), contentType: 'application/pdf', filename: `${base}.pdf` };
    return {
      body: Buffer.from(JSON.stringify(r, null, 2), 'utf8'),
      contentType: 'application/json; charset=utf-8',
      filename: `${base}.json`,
    };
  }

  private pdf(r: EvidenceResult): Buffer {
    const c = r.control;
    const lines: PdfLine[] = [
      { text: `KORA control evidence - ${c.id} ${c.title}`, font: 'F2', size: 14 },
      {
        text: `Period ${r.range.from} to ${r.range.to} (end exclusive). Generated ${r.generatedAt} by ${r.generatedBy}. Environment PAPER; data SIMULATED.`,
        size: 8,
        gap: 2,
      },
      { text: `Objective: ${c.objective}`, gap: 6 },
      {
        text: `COBIT 2019: ${c.cobit.join(', ')}    Owner: line ${c.ownerLine} - ${c.owner}    Frequency: ${c.frequency}    Nature: ${c.nature}, ${c.automation}`,
      },
      { text: `Risk addressed: ${c.risk}` },
      { text: `Automated evidence (${c.evidence.kind}): ${c.evidence.source}` },
      { text: 'Summary', font: 'F2', size: 10, gap: 8 },
      ...Object.entries(r.evidence.summary).map(([k, v]) => ({
        text: `${k}: ${v === null ? '-' : String(v)}`,
        font: 'F3' as const,
        size: 8,
      })),
      { text: 'Test procedure', font: 'F2', size: 10, gap: 8 },
      ...c.testProcedure.map((t, i) => ({ text: `${i + 1}. ${t}`, size: 8 })),
      { text: `Evidence (${r.evidence.rows.length} rows)`, font: 'F2', size: 10, gap: 8 },
      ...tableLines(
        r.evidence.columns,
        r.evidence.rows.length ? r.evidence.rows : [r.evidence.columns.map(() => null)],
      ),
    ];
    return renderPdf(lines, {
      title: `${c.id} evidence ${r.range.from.slice(0, 10)}..${r.range.to.slice(0, 10)}`,
      footer: `KORA ${c.id} evidence export`,
    });
  }

  /** Runs, renders and audits one export. */
  async export(id: string, range: Range, format: EvidenceFormat, actor: string) {
    const r = await this.run(id, range, actor);
    const file = this.render(r, format);
    const sha256 = createHash('sha256').update(file.body).digest('hex');
    await this.audit.record({
      actorId: actor,
      actorType: 'user',
      action: 'governance.evidence_exported',
      entity: 'control',
      entityId: id,
      payload: {
        controlId: id,
        from: r.range.from,
        to: r.range.to,
        format,
        rows: r.evidence.rows.length,
        sha256,
      },
    });
    return { ...file, sha256, rows: r.evidence.rows.length };
  }
}
