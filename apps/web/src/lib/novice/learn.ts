import type { MessageKey } from '../i18n';

/** 2-minute lessons (goal 08 §7): ids map to `lesson.<id>.*` copy (title, summary, p1–p4). */
export const LESSONS = ['trading', 'costs', 'safety-net', 'borrowing', 'losses'] as const;
export type LessonId = (typeof LESSONS)[number];

export function lessonKeys(id: LessonId) {
  return {
    title: `lesson.${id}.title` as MessageKey,
    summary: `lesson.${id}.summary` as MessageKey,
    paragraphs: [1, 2, 3, 4].map((n) => `lesson.${id}.p${n}` as MessageKey),
  };
}

export function isLesson(v: string): v is LessonId {
  return (LESSONS as readonly string[]).includes(v);
}

/** Glossary terms (goal 08 §7): every `[text](term:id)` in the copy must point at one of these. */
export const GLOSSARY = [
  'spread',
  'fees',
  'costs',
  'safety-net',
  'leverage',
  'loss-limit',
  'cooling-off',
  'practice-money',
  'robot',
  'past-results',
  'dip',
  'simulation',
  'range',
] as const;
export type GlossaryId = (typeof GLOSSARY)[number];

export const termKeys = (id: GlossaryId) => ({
  name: `term.${id}.name` as MessageKey,
  meaning: `term.${id}.meaning` as MessageKey,
});
