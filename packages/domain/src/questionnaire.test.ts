import { describe, expect, it } from 'vitest';

import {
  AttemptSchema,
  grade,
  publicView,
  QuestionnaireDefinitionSchema,
  type QuestionnaireDefinition,
} from './questionnaire.js';

const def: QuestionnaireDefinition = {
  id: 'appropriateness',
  version: 1,
  kind: 'appropriateness',
  title: 'T',
  intro: 'I',
  locale: 'en',
  simulated: true,
  reviewStatus: 'placeholder_pending_compliance_review',
  passMarkPct: 75,
  cooldownMinutes: 60,
  questions: [
    {
      id: 'q1',
      topic: 'leverage',
      prompt: 'P1',
      help: 'H',
      options: [
        { id: 'a', label: 'A', points: 1 },
        { id: 'b', label: 'B', points: 0 },
      ],
    },
    {
      id: 'q2',
      topic: 'stops',
      prompt: 'P2',
      options: [
        { id: 'a', label: 'A', points: 0 },
        { id: 'b', label: 'B', points: 1 },
      ],
    },
    {
      id: 'q3',
      topic: 'gaps',
      prompt: 'P3',
      options: [
        { id: 'a', label: 'A', points: 1 },
        { id: 'b', label: 'B', points: 0 },
      ],
    },
    {
      id: 'q4',
      topic: 'costs',
      prompt: 'P4',
      options: [
        { id: 'a', label: 'A', points: 2 },
        { id: 'b', label: 'B', points: 1 },
        { id: 'c', label: 'C', points: 0 },
      ],
    },
  ],
};

describe('questionnaire engine', () => {
  it('validates definitions', () => {
    expect(QuestionnaireDefinitionSchema.safeParse(def).success).toBe(true);
    const dup = { ...def, questions: [def.questions[0], def.questions[0]] };
    expect(QuestionnaireDefinitionSchema.safeParse(dup).success).toBe(false);
    const dupOpt = {
      ...def,
      questions: [
        {
          ...def.questions[0]!,
          options: [
            { id: 'a', label: 'A', points: 1 },
            { id: 'a', label: 'B', points: 0 },
          ],
        },
      ],
    };
    expect(QuestionnaireDefinitionSchema.safeParse(dupOpt).success).toBe(false);
    const noScore = {
      ...def,
      questions: [
        {
          ...def.questions[0]!,
          options: [
            { id: 'a', label: 'A', points: 0 },
            { id: 'b', label: 'B', points: 0 },
          ],
        },
      ],
    };
    expect(QuestionnaireDefinitionSchema.safeParse(noScore).success).toBe(false);
  });

  it('public view never exposes points and applies overrides', () => {
    const v = publicView(def, { passMarkPct: 80 });
    expect(JSON.stringify(v)).not.toContain('points');
    expect(v.passMarkPct).toBe(80);
    expect(v.cooldownMinutes).toBe(60);
    expect(v.questions[0]).toHaveProperty('help', 'H');
    expect(v.questions[1]).not.toHaveProperty('help');
  });

  it('grades weighted options, floors the percent, and needs every answer', () => {
    expect(grade(def, { q1: 'a', q2: 'b', q3: 'a', q4: 'a' })).toMatchObject({
      score: 5,
      maxScore: 5,
      scorePct: 100,
      passed: true,
    });
    // 4 / 5 = 80% ≥ 75
    expect(grade(def, { q1: 'a', q2: 'b', q3: 'a', q4: 'b' })).toMatchObject({
      scorePct: 80,
      passed: true,
    });
    // 3 / 5 = 60%
    expect(grade(def, { q1: 'a', q2: 'b', q3: 'b', q4: 'b' })).toMatchObject({
      scorePct: 60,
      passed: false,
    });
    expect(grade(def, { q1: 'a', q2: 'b', q3: 'a' })).toMatchObject({
      passed: false,
      missing: ['q4'],
    });
    expect(grade(def, { q1: 'a', q2: 'b', q3: 'a', q4: 'a', q9: 'a' })).toMatchObject({
      passed: false,
      unknown: ['q9'],
    });
    expect(grade(def, { q1: 'z', q2: 'b', q3: 'a', q4: 'a' }).missing).toEqual(['q1']);
    expect(grade(def, { q1: 'a', q2: 'b', q3: 'a', q4: 'b' }, 81).passed).toBe(false);
  });

  it('validates attempts', () => {
    expect(
      AttemptSchema.safeParse({
        questionnaireId: 'appropriateness',
        version: 1,
        answers: { q1: 'a' },
      }).success,
    ).toBe(true);
    expect(
      AttemptSchema.safeParse({
        questionnaireId: 'x',
        version: 1,
        answers: { q1: 'a' },
        score: 100,
      }).success,
    ).toBe(false);
  });
});
