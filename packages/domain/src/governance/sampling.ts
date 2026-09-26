/**
 * Reproducible random sampling for internal audit (goal 09): the same seed and the same population
 * always give the same sample, so an auditor's sample can be re-drawn and checked later.
 * mulberry32 PRNG + a partial Fisher–Yates shuffle. Not for cryptography.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Parses a seed string (digits, or any text hashed with FNV-1a) into a 32-bit integer. */
export function seedFrom(input: string): number {
  if (/^\d{1,9}$/.test(input)) return Number(input) >>> 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Draws `n` distinct items (fewer if the population is smaller), in population order. */
export function sample<T>(population: readonly T[], n: number, seed: number): T[] {
  const idx = population.map((_, i) => i);
  const rnd = mulberry32(seed);
  const k = Math.min(Math.max(0, Math.floor(n)), idx.length);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rnd() * (idx.length - i));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  return idx
    .slice(0, k)
    .sort((a, b) => a - b)
    .map((i) => population[i]!);
}
