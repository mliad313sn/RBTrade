import { randomInt } from 'node:crypto';

import { Injectable, NotFoundException } from '@nestjs/common';
import { sample, seedFrom, type AuditEvent } from '@kora/domain';

import { AuditService, type AuditQuery } from '../audit/audit.service';
import { DbService } from '../db/db.service';
import { AnchorsService } from './anchors.service';
import { controlById } from './controls/catalogue';
import { EvidenceService } from './controls/evidence.service';
import type { Range } from './controls/evidence-queries';
import { toCsv } from './export/csv';

const POPULATION_CAP = 200_000;

/**
 * Internal audit (goal 09, 3rd line): read-only audit browsing, chain + anchor verification and
 * reproducible random sampling per control. The only writes are the audit events that record what
 * the auditor did (verification run, sample drawn, export).
 */
@Injectable()
export class InternalAuditService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly anchors: AnchorsService,
    private readonly evidence: EvidenceService,
  ) {}

  events(q: AuditQuery) {
    return this.audit.list(q);
  }

  async exportEvents(q: AuditQuery, actor: string) {
    const page = await this.audit.list({ ...q, limit: 500 });
    const csv = toCsv(
      ['id', 'ts', 'actor_id', 'actor_type', 'action', 'entity', 'entity_id', 'payload', 'prev_hash', 'hash'],
      page.events.map((e) => [e.id, e.ts, e.actorId, e.actorType, e.action, e.entity, e.entityId, JSON.stringify(e.payload), e.prevHash, e.hash]),
    );
    await this.audit.record({
      actorId: actor,
      actorType: 'user',
      action: 'internal_audit.events_exported',
      entity: 'audit_events',
      entityId: null,
      payload: { filter: JSON.parse(JSON.stringify(q)) as Record<string, string>, rows: page.events.length },
    });
    return { csv, rows: page.events.length, nextBeforeId: page.nextBeforeId };
  }

  /** Recomputes the chain and checks every anchor; the run itself is recorded. */
  async verify(actor: string) {
    const chain = await this.audit.verify();
    const anchors = await this.anchors.list();
    // IRTC R4-07: the chain head against the latest trusted anchor, and the WORM copy read back.
    const worm = await this.anchors.wormCheck();
    const out = {
      chain,
      anchors: {
        count: anchors.length,
        invalidSignatures: anchors.filter((a) => !a.signatureValid).length,
        untrustedKeys: anchors.filter((a) => !a.trustedKey).length,
        notMatchingChain: anchors.filter((a) => !a.matchesChain).length,
        latest: anchors[0] ?? null,
        headWitness: chain.anchor ?? null,
        eventsAfterLastAnchor: chain.anchor?.eventsAfterLastAnchor ?? null,
        worm,
      },
      verifiedAt: new Date().toISOString(),
    };
    await this.audit.record({
      actorId: actor,
      actorType: 'user',
      action: 'internal_audit.chain_verified',
      entity: 'audit_events',
      entityId: null,
      payload: {
        valid: chain.valid,
        count: chain.count,
        firstBrokenId: chain.firstBrokenId,
        headHash: chain.headHash,
        anchors: anchors.length,
        anchorsInvalid: out.anchors.invalidSignatures + out.anchors.notMatchingChain,
        reason: chain.reason,
        eventsAfterLastAnchor: out.anchors.eventsAfterLastAnchor,
        wormInvalid: worm.invalidSignatures + worm.missingInDatabase + worm.notMatchingChain,
      },
    });
    return out;
  }

  /**
   * Draws `n` items at random for a control: its audit events in the period (by the control's audit
   * actions), or the rows of its evidence table when the control has no audit actions. Same seed,
   * same population → same sample.
   */
  async sample(controlId: string, n: number, range: Range, seedInput: string | undefined, actor: string) {
    const control = controlById(controlId);
    if (!control) throw new NotFoundException({ error: 'not_found', message: `No control ${controlId}.` });
    const seedText = seedInput ?? String(randomInt(1, 2 ** 31 - 1));
    const seed = seedFrom(seedText);
    let result: {
      population: number;
      kind: 'audit_events' | 'evidence_rows';
      events?: AuditEvent[];
      columns?: string[];
      rows?: Array<Array<string | number | boolean | null>>;
    };
    if (control.auditActions.length) {
      const ids = (
        await this.db.query<{ id: string }>(
          `SELECT e.id::text AS id FROM audit_events e WHERE e.action = ANY($1::text[]) AND e.ts >= $2 AND e.ts < $3 ORDER BY e.id LIMIT ${POPULATION_CAP}`,
          [control.auditActions, range.from, range.to],
        )
      ).map((r) => r.id);
      const picked = sample(ids, n, seed);
      const events = await this.audit.byIds(picked);
      result = { population: ids.length, kind: 'audit_events', events };
    } else {
      const ev = await this.evidence.run(controlId, range, actor);
      const rows = sample(ev.evidence.rows, n, seed);
      result = { population: ev.evidence.rows.length, kind: 'evidence_rows', columns: ev.evidence.columns, rows };
    }
    const size = result.events?.length ?? result.rows?.length ?? 0;
    await this.audit.record({
      actorId: actor,
      actorType: 'user',
      action: 'internal_audit.sample_drawn',
      entity: 'control',
      entityId: controlId,
      payload: {
        controlId,
        seed: seedText,
        n: String(n),
        population: result.population,
        drawn: size,
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        eventIds: (result.events ?? []).slice(0, 100).map((e) => e.id),
      },
    });
    return {
      controlId,
      title: control.title,
      seed: seedText,
      requested: n,
      drawn: size,
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      ...result,
    };
  }
}
