/**
 * Flesch–Kincaid grade level, computed in code (deterministic grader and runtime guard for the
 * novice "Explain this to me" answers, which must be grade 8 or below).
 *
 * grade = 0.39 × (words / sentences) + 11.8 × (syllables / words) − 15.59
 *
 * Syllables use the usual vowel-group heuristic (silent trailing "e", "-le" endings). Numbers count as
 * one word of two syllables; the disclaimer line is excluded by the caller.
 */
export function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return /\d/.test(word) ? 2 : 0;
  if (w.length <= 3) return 1;
  let s =
    w
      .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '')
      .replace(/^y/, '')
      .match(/[aeiouy]{1,2}/g)?.length ?? 1;
  if (/[^aeiouy]le$/.test(w)) s += 1;
  return Math.max(1, s);
}

export function textStats(text: string): { words: number; sentences: number; syllables: number } {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const words = cleaned.split(' ').filter((t) => /[A-Za-z0-9]/.test(t));
  const sentences = Math.max(
    1,
    (cleaned.match(/[.!?]+(\s|$)/g) ?? []).length || (words.length ? 1 : 0),
  );
  const syllables = words.reduce((a, w) => a + countSyllables(w), 0);
  return { words: words.length, sentences, syllables };
}

export function fleschKincaidGrade(text: string): number {
  const { words, sentences, syllables } = textStats(text);
  if (words === 0) return 0;
  const g = 0.39 * (words / sentences) + 11.8 * (syllables / words) - 15.59;
  return Math.round(g * 10) / 10;
}
