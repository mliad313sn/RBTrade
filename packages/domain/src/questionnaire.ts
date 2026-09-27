import { z } from 'zod';

/**
 * Questionnaire engine (B-018; reused by goal 08 knowledge checks and goal 09 suitability).
 * Definitions are versioned data, reviewed by Compliance. Each option carries points: right/wrong
 * tests use 1/0, profile questionnaires (suitability) use weights. Grading is server-side only;
 * the public view never contains points.
 */

export const QUESTIONNAIRE_KINDS = ['appropriateness', 'knowledge_check', 'suitability'] as const;
export type QuestionnaireKind = (typeof QUESTIONNAIRE_KINDS)[number];

export const REVIEW_STATUSES = ['placeholder_pending_compliance_review', 'approved'] as const;

const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

export const QuestionnaireDefinitionSchema = z
  .object({
    id,
    version: z.number().int().min(1).max(10_000),
    kind: z.enum(QUESTIONNAIRE_KINDS),
    title: z.string().min(1).max(160),
    intro: z.string().min(1).max(2000),
    locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
    /** True while the questions are placeholders; the UI labels them SIMULATED. */
    simulated: z.boolean(),
    reviewStatus: z.enum(REVIEW_STATUSES),
    /** Minimum score in percent of the maximum (inclusive). */
    passMarkPct: z.number().int().min(0).max(100),
    /** Minutes before another attempt is allowed after a fail. */
    cooldownMinutes: z.number().int().min(0).max(525_600),
    questions: z
      .array(
        z
          .object({
            id,
            topic: z.string().min(1).max(80),
            prompt: z.string().min(1).max(1000),
            help: z.string().max(1000).optional(),
            options: z
              .array(
                z
                  .object({
                    id,
                    label: z.string().min(1).max(500),
                    points: z.number().int().min(0).max(100),
                  })
                  .strict(),
              )
              .min(2)
              .max(8),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((q, ctx) => {
    const qids = new Set<string>();
    for (const [i, question] of q.questions.entries()) {
      if (qids.has(question.id))
        ctx.addIssue({
          code: 'custom',
          path: ['questions', i, 'id'],
          message: 'duplicate question id',
        });
      qids.add(question.id);
      const oids = new Set(question.options.map((o) => o.id));
      if (oids.size !== question.options.length)
        ctx.addIssue({
          code: 'custom',
          path: ['questions', i, 'options'],
          message: 'duplicate option id',
        });
      if (Math.max(...question.options.map((o) => o.points)) <= 0)
        ctx.addIssue({
          code: 'custom',
          path: ['questions', i, 'options'],
          message: 'at least one option must score',
        });
    }
  });
export type QuestionnaireDefinition = z.infer<typeof QuestionnaireDefinitionSchema>;

export interface PublicQuestionnaire {
  id: string;
  version: number;
  kind: QuestionnaireKind;
  title: string;
  intro: string;
  locale: string;
  simulated: boolean;
  reviewStatus: QuestionnaireDefinition['reviewStatus'];
  passMarkPct: number;
  cooldownMinutes: number;
  questions: Array<{
    id: string;
    topic: string;
    prompt: string;
    help?: string;
    options: Array<{ id: string; label: string }>;
  }>;
}

export function publicView(
  q: QuestionnaireDefinition,
  overrides: { passMarkPct?: number; cooldownMinutes?: number } = {},
): PublicQuestionnaire {
  return {
    id: q.id,
    version: q.version,
    kind: q.kind,
    title: q.title,
    intro: q.intro,
    locale: q.locale,
    simulated: q.simulated,
    reviewStatus: q.reviewStatus,
    passMarkPct: overrides.passMarkPct ?? q.passMarkPct,
    cooldownMinutes: overrides.cooldownMinutes ?? q.cooldownMinutes,
    questions: q.questions.map((x) => ({
      id: x.id,
      topic: x.topic,
      prompt: x.prompt,
      ...(x.help ? { help: x.help } : {}),
      options: x.options.map((o) => ({ id: o.id, label: o.label })),
    })),
  };
}

export const AttemptSchema = z
  .object({
    questionnaireId: id,
    version: z.number().int().min(1),
    answers: z.record(id, id),
    /**
     * IRTC R4-09: the risk warning the user read and confirmed on the assessment page (version and
     * content hash of the text in force). Required by the appropriateness assessment, whose pass
     * records it as the user's acknowledgement; other questionnaires ignore it.
     */
    riskWarning: z
      .object({
        version: z.string().min(1).max(64),
        contentHash: z.string().regex(/^[0-9a-f]{64}$/),
        locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
      })
      .strict()
      .optional(),
  })
  .strict();
export type AttemptRequest = z.infer<typeof AttemptSchema>;

export interface GradeResult {
  score: number;
  maxScore: number;
  /** Integer percent, floored (a pass is never rounded up). */
  scorePct: number;
  passed: boolean;
  missing: string[];
  unknown: string[];
}

export function grade(
  q: QuestionnaireDefinition,
  answers: Record<string, string>,
  passMarkPct = q.passMarkPct,
): GradeResult {
  let score = 0;
  let maxScore = 0;
  const missing: string[] = [];
  const known = new Set(q.questions.map((x) => x.id));
  const unknown = Object.keys(answers).filter((k) => !known.has(k));
  for (const question of q.questions) {
    maxScore += Math.max(...question.options.map((o) => o.points));
    const chosen = answers[question.id];
    const option = question.options.find((o) => o.id === chosen);
    if (!option) {
      missing.push(question.id);
      continue;
    }
    score += option.points;
  }
  const scorePct = maxScore === 0 ? 0 : Math.floor((score * 100) / maxScore);
  return {
    score,
    maxScore,
    scorePct,
    passed: missing.length === 0 && unknown.length === 0 && scorePct >= passMarkPct,
    missing,
    unknown,
  };
}
