import { Injectable, NotFoundException } from '@nestjs/common';
import type { GradeResult } from '@kora/domain';

import { QuestionnaireService } from '../appropriateness/questionnaire.service';
import { AuditService } from '../audit/audit.service';
import { DbService } from '../db/db.service';

export const SUITABILITY_ID = 'suitability';

/**
 * Band thresholds on the suitability score (percent of the maximum). SIMULATED placeholders pending
 * Compliance (OQ-C2); `KORA_SUITABILITY_BANDS=34,67` overrides them. Band names describe the answers
 * given; the platform never turns them into a recommendation.
 */
export function suitabilityBands(env: NodeJS.ProcessEnv = process.env): [number, number] {
  const raw = env.KORA_SUITABILITY_BANDS?.trim();
  const m = raw?.match(/^(\d{1,2}),(\d{1,3})$/);
  if (m && Number(m[1]) < Number(m[2]) && Number(m[2]) <= 100) return [Number(m[1]), Number(m[2])];
  return [34, 67];
}

export type SuitabilityBand = 'cautious' | 'balanced' | 'adventurous';

export function bandFor(scorePct: number, bands = suitabilityBands()): SuitabilityBand {
  return scorePct < bands[0] ? 'cautious' : scorePct < bands[1] ? 'balanced' : 'adventurous';
}

/**
 * Suitability / appropriateness profile (goal 09) on the goal 03 questionnaire engine: the goal 03
 * appropriateness assessment, the goal 08 knowledge check and the suitability questionnaire feed one
 * profile. Only scores are stored (never answers). The profile records what the customer told us; it
 * produces no recommendation and no product advice.
 */
@Injectable()
export class SuitabilityService {
  constructor(
    private readonly q: QuestionnaireService,
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  def() {
    void this.q.ensureSynced().catch(() => undefined);
    const d = this.q.get(SUITABILITY_ID);
    if (!d) throw new NotFoundException({ error: 'not_found', message: 'No suitability questionnaire is published.' });
    return d;
  }

  questionnaire() {
    return { questionnaire: this.q.view(this.def()), bands: suitabilityBands(), simulated: true };
  }

  async submit(userId: string, body: { questionnaireId: string; version: number; answers: Record<string, string> }) {
    const def = this.def();
    if (body.questionnaireId !== def.id || body.version !== def.version)
      throw new NotFoundException({ error: 'stale_questionnaire', message: 'This questionnaire version is no longer current. Reload it.' });
    await this.q.ensureSynced();
    const g: GradeResult & { passMarkPct: number; topicsToReview: string[] } = this.q.grade(def, body.answers);
    const band = bandFor(g.scorePct);
    await this.db.tx(async (c) => {
      const row = await this.q.record(c, userId, def, g);
      await this.audit.record(
        {
          actorId: userId,
          actorType: 'user',
          action: 'suitability.completed',
          entity: 'questionnaire',
          entityId: def.id,
          payload: { attemptId: row.id, version: def.version, scorePct: g.scorePct, band, simulated: def.simulated },
        },
        c,
      );
    });
    return { scorePct: g.scorePct, band, simulated: def.simulated, profile: await this.profile(userId) };
  }

  async profile(userId: string) {
    const last = async (id: string) => this.q.lastAttempt(userId, id);
    const [appr, kc, suit] = await Promise.all([last('appropriateness'), last('knowledge-check'), last(SUITABILITY_ID)]);
    const passed = await this.db.query<{ questionnaire_id: string; version: number; created_at: Date }>(
      `SELECT DISTINCT ON (questionnaire_id) questionnaire_id, version, created_at FROM questionnaire_attempts
       WHERE user_id = $1 AND passed AND questionnaire_id IN ('appropriateness', 'knowledge-check')
       ORDER BY questionnaire_id, created_at DESC`,
      [userId],
    );
    const passedOf = (id: string) => passed.find((p) => p.questionnaire_id === id);
    const view = (a: Awaited<ReturnType<typeof last>>, id: string) =>
      a
        ? {
            lastAttempt: { version: a.version, scorePct: a.score_pct, passed: a.passed, at: a.created_at.toISOString() },
            everPassed: passedOf(id) ? { version: passedOf(id)!.version, at: passedOf(id)!.created_at.toISOString() } : null,
          }
        : null;
    return {
      userId,
      appropriateness: view(appr, 'appropriateness'),
      knowledgeCheck: view(kc, 'knowledge-check'),
      suitability: suit
        ? { version: suit.version, scorePct: suit.score_pct, band: bandFor(suit.score_pct), at: suit.created_at.toISOString() }
        : null,
      complete: !!appr && !!suit,
      simulated: true,
      notAdvice: 'This profile records the answers given. It is not a recommendation or personal advice.',
    };
  }
}
