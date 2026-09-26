import { createHash } from 'node:crypto';

import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  canonicalJson,
  grade,
  publicView,
  QuestionnaireDefinitionSchema,
  type GradeResult,
  type PublicQuestionnaire,
  type QuestionnaireDefinition,
} from '@kora/domain';

import { DbService, type Queryable } from '../db/db.service';
import appropriatenessV1 from './questionnaires/appropriateness.v1.json';
import knowledgeCheckV1 from './questionnaires/knowledge-check.v1.json';
import suitabilityV1 from './questionnaires/suitability.v1.json';

/**
 * Every published questionnaire version, as reviewed data. Adding a version = adding a file here;
 * editing a published file fails the boot (versions are immutable, see `sync`).
 */
export const QUESTIONNAIRE_FILES: unknown[] = [appropriatenessV1, knowledgeCheckV1, suitabilityV1];

export interface AttemptRow {
  id: string;
  questionnaire_id: string;
  version: number;
  score: number;
  max_score: number;
  score_pct: number;
  pass_mark_pct: number;
  passed: boolean;
  created_at: Date;
}

export class QuestionnaireIntegrityError extends Error {}

/**
 * Generic questionnaire engine (B-018): appropriateness today; goal 08 knowledge checks and goal 09
 * suitability reuse it by adding a definition file with their `kind` and calling `grade`/`record`.
 * Pass mark and cool-down come from the data, overridable per id by env
 * (`KORA_<ID>_PASS_MARK_PCT`, `KORA_<ID>_COOLDOWN_MINUTES`, e.g. KORA_APPROPRIATENESS_PASS_MARK_PCT).
 */
@Injectable()
export class QuestionnaireService implements OnApplicationBootstrap {
  private readonly log = new Logger('Questionnaires');
  private readonly active = new Map<string, QuestionnaireDefinition>();

  constructor(private readonly db: DbService) {
    for (const raw of QUESTIONNAIRE_FILES) {
      const def = QuestionnaireDefinitionSchema.parse(raw);
      const cur = this.active.get(def.id);
      if (!cur || cur.version < def.version) this.active.set(def.id, def);
    }
  }

  private synced = false;

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.sync();
    } catch (e) {
      // Schema not migrated yet (e.g. e2e starts the api before its global setup migrates):
      // retry on first use. Integrity errors (a changed published version) still fail loudly.
      if ((e as { code?: string }).code !== '42P01') throw e;
      this.log.warn('questionnaires table missing; will publish questionnaires on first use');
    }
  }

  /** Publishes the definitions if boot could not (idempotent). */
  async ensureSynced(): Promise<void> {
    if (!this.synced) await this.sync();
  }

  static checksum(def: QuestionnaireDefinition): string {
    return createHash('sha256').update(canonicalJson(def)).digest('hex');
  }

  /** Inserts new versions; refuses to boot if a published version's content changed. */
  async sync(): Promise<void> {
    for (const raw of QUESTIONNAIRE_FILES) {
      const def = QuestionnaireDefinitionSchema.parse(raw);
      const sum = QuestionnaireService.checksum(def);
      const existing = await this.db.query<{ checksum: string }>(
        'SELECT checksum FROM questionnaires WHERE id = $1 AND version = $2',
        [def.id, def.version],
      );
      if (existing[0]) {
        if (existing[0].checksum !== sum) {
          throw new QuestionnaireIntegrityError(
            `questionnaire ${def.id} v${def.version} changed after publication; publish a new version instead`,
          );
        }
        continue;
      }
      await this.db.query(
        `INSERT INTO questionnaires (id, version, kind, title, definition, checksum, simulated, review_status)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8) ON CONFLICT (id, version) DO NOTHING`,
        [
          def.id,
          def.version,
          def.kind,
          def.title,
          JSON.stringify(def),
          sum,
          def.simulated,
          def.reviewStatus,
        ],
      );
      this.log.log(
        `published questionnaire ${def.id} v${def.version}${def.simulated ? ' (SIMULATED placeholder)' : ''}`,
      );
    }
  }

  private envKey(id: string, what: string): string {
    return `KORA_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${what}`;
  }

  settings(def: QuestionnaireDefinition): { passMarkPct: number; cooldownMinutes: number } {
    // Empty or missing env values mean "use the reviewed data" (never a pass mark of 0).
    const read = (what: string): number => {
      const raw = process.env[this.envKey(def.id, what)]?.trim();
      return raw && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    };
    const pass = read('PASS_MARK_PCT');
    const cool = read('COOLDOWN_MINUTES');
    return {
      passMarkPct: Number.isInteger(pass) && pass >= 0 && pass <= 100 ? pass : def.passMarkPct,
      cooldownMinutes: Number.isInteger(cool) && cool >= 0 ? cool : def.cooldownMinutes,
    };
  }

  get(id: string): QuestionnaireDefinition | null {
    return this.active.get(id) ?? null;
  }

  view(def: QuestionnaireDefinition): PublicQuestionnaire {
    return publicView(def, this.settings(def));
  }

  grade(
    def: QuestionnaireDefinition,
    answers: Record<string, string>,
  ): GradeResult & { passMarkPct: number; topicsToReview: string[] } {
    const s = this.settings(def);
    const g = grade(def, answers, s.passMarkPct);
    const topicsToReview = def.questions
      .filter((q) => {
        const best = Math.max(...q.options.map((o) => o.points));
        return (q.options.find((o) => o.id === answers[q.id])?.points ?? 0) < best;
      })
      .map((q) => q.topic);
    return { ...g, passMarkPct: s.passMarkPct, topicsToReview };
  }

  async lastAttempt(userId: string, id: string, c?: Queryable): Promise<AttemptRow | null> {
    const r = await (c ?? this.db.pool).query<AttemptRow>(
      'SELECT * FROM questionnaire_attempts WHERE user_id = $1 AND questionnaire_id = $2 ORDER BY created_at DESC LIMIT 1',
      [userId, id],
    );
    return r.rows[0] ?? null;
  }

  /** Stores the score only (never the answers). */
  async record(
    c: Queryable,
    userId: string,
    def: QuestionnaireDefinition,
    g: GradeResult & { passMarkPct: number },
    /** Optional attempt time on the application clock (the cool-down is computed on it). */
    at?: Date,
  ): Promise<AttemptRow> {
    const r = await c.query<AttemptRow>(
      `INSERT INTO questionnaire_attempts (user_id, questionnaire_id, version, score, max_score, score_pct, pass_mark_pct, passed, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, clock_timestamp())) RETURNING *`,
      [
        userId,
        def.id,
        def.version,
        g.score,
        g.maxScore,
        g.scorePct,
        g.passMarkPct,
        g.passed,
        at ?? null,
      ],
    );
    return r.rows[0]!;
  }

  cooldownUntil(def: QuestionnaireDefinition, last: AttemptRow | null): Date | null {
    const minutes = this.settings(def).cooldownMinutes;
    if (!last || last.passed || minutes === 0) return null;
    const until = last.created_at.getTime() + minutes * 60_000;
    return until > Date.now() ? new Date(until) : null;
  }
}
