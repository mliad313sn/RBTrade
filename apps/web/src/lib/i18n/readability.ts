import { plain } from './index';

/**
 * Readability (goal 08 §9: grade 8 or lower). English: Flesch–Kincaid grade level
 *   0.39 × (words / sentences) + 11.8 × (syllables / words) − 15.59
 * French (information only): Kandel & Moles' adaptation of Flesch reading ease
 *   207 − 1.015 × (words / sentences) − 73.6 × (syllables / words)   (60–70 ≈ plain language)
 * Markup and `{variables}` are removed first (a variable counts as one short word).
 */

export interface TextStats {
  words: number;
  sentences: number;
  syllables: number;
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

export function clean(text: string): string {
  return plain(text)
    .replace(/\{\w+\}/g, 'it')
    .replace(/[▲▼↗·•→←]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Heuristic English syllable count (vowel groups, silent final e, minimum 1). */
export function syllablesEn(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 1; // numbers, symbols
  if (w.length <= 3) return 1;
  const s =
    w
      .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '')
      .replace(/^y/, '')
      .match(/[aeiouy]{1,2}/g)?.length ?? 1;
  return Math.max(1, s);
}

/** Heuristic French syllable count (vowel groups, mute final e / es / ent). */
export function syllablesFr(word: string): number {
  const w = word.toLowerCase().replace(/[^a-zàâäéèêëîïôöùûüÿœæ]/g, '');
  if (!w) return 1;
  const stem = w.length > 3 ? w.replace(/(?:e|es|ent)$/, '') : w;
  return Math.max(1, stem.match(/[aeiouyàâäéèêëîïôöùûüÿœæ]+/g)?.length ?? 1);
}

export function stats(text: string, syllables: (w: string) => number): TextStats {
  const t = clean(text);
  const words = t.match(WORD) ?? [];
  const sentences = Math.max(1, (t.match(/[.!?…]+(?=\s|$)/g) ?? []).length || 1);
  return { words: words.length, sentences, syllables: words.reduce((s, w) => s + syllables(w), 0) };
}

export function fkGrade(s: TextStats): number {
  if (s.words === 0) return 0;
  return 0.39 * (s.words / s.sentences) + 11.8 * (s.syllables / s.words) - 15.59;
}

export function kandelMoles(s: TextStats): number {
  if (s.words === 0) return 100;
  return 207 - 1.015 * (s.words / s.sentences) - 73.6 * (s.syllables / s.words);
}

export function sum(list: TextStats[]): TextStats {
  return list.reduce(
    (a, b) => ({
      words: a.words + b.words,
      sentences: a.sentences + b.sentences,
      syllables: a.syllables + b.syllables,
    }),
    {
      words: 0,
      sentences: 0,
      syllables: 0,
    },
  );
}

/** Keys that are labels or names, not prose (excluded from the corpus). */
export function isProse(key: string, text: string): boolean {
  if (
    // appr.q / appr.topic: the appropriateness questionnaire, verbatim from the graded, Compliance-owned
    // data file (IRTC R5-12); its wording is reviewed by Compliance (OQ-C1), not by the Novice copy gate.
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- linear pattern (no nested quantifiers), reviewed goal 10
    /^(ccy|nav|mode|shell\.nav|shell\.lang|kc\.topic|appr\.q\.|appr\.topic|term\.[\w-]+\.name|ai\.t\.[\w-]+\.name)/.test(
      key,
    )
  )
    return false;
  return (clean(text).match(WORD) ?? []).length >= 4;
}
