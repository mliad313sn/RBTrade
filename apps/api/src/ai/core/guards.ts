import { matchVariants, normaliseText } from './normalise';
import { fleschKincaidGrade } from './readability';
import { DISCLAIMER, type AiMode } from './types';
import { isUntrustedKey, UNTRUSTED_OPEN } from './untrusted';

/**
 * Output guards, all deterministic code (also used as eval graders):
 * - numeric fidelity: every number in an answer must come from a tool output, the server-side
 *   grounding or the user's own question;
 * - execution claims: the copilot cannot place, amend or cancel orders or start robots, so an answer
 *   claiming it did is replaced;
 * - novice: readability grade ≤ 8 and no trade suggestions;
 * - the "Not investment advice." line.
 */

export interface ExtractedNumber {
  raw: string;
  /** Absolute value, normalised decimal string (no sign, no thousands separators, no trailing zeros). */
  norm: string;
  value: number;
  decimals: number;
  percent: boolean;
}

// A number not glued to letters on its left (EMA20, v3, H1 are identifiers, not figures).
const NUM_RE = /(?<![A-Za-z_\d.])[-+−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(%?)/g;

export function normaliseNumber(s: string): string {
  let t = s.replace(/[+−-]/g, '').replace(/,/g, '').replace(/%$/, '');
  if (t.includes('.')) t = t.replace(/0+$/, '').replace(/\.$/, '');
  t = t.replace(/^0+(?=\d)/, '');
  return t === '' ? '0' : t;
}

export function extractNumbers(text: string): ExtractedNumber[] {
  const out: ExtractedNumber[] = [];
  for (const m of text.matchAll(NUM_RE)) {
    const raw = m[0];
    const body = raw.replace(/%$/, '');
    const norm = normaliseNumber(body);
    const dot = body.indexOf('.');
    // "57 percent" is a percentage too.
    const after = text.slice((m.index ?? 0) + raw.length, (m.index ?? 0) + raw.length + 12);
    out.push({
      raw,
      norm,
      value: Number(norm),
      decimals: dot >= 0 ? body.length - dot - 1 : 0,
      percent: raw.endsWith('%') || /^\s*(?:percent|per\s*cent|pct)\b/i.test(after),
    });
  }
  return out;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_TS_RE =
  /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g;
const HEX_RE = /\b[0-9a-f]{16,}\b/gi;
const DECIMAL_STRING_RE = /^[-+]?\d+(?:\.\d+)?$/;
/** Keys whose string values are identifiers, hashes, times or links: never a source of figures. */
const IDENTIFIER_KEY_RE =
  /^(?:id|ids|uuid|hash|ts|url|href|link|modelkey|clientorderid|cursor|etag|version|contenthash|prompthash|inputhash)$|(?:Id|Ids|_id|_ids|Hash|_hash|Ts|_ts|At|_at|Url|_url)$/;

/**
 * Every figure the sources vouch for (IRTC R4-03): numeric leaves, decimal strings and numbers inside
 * KORA-generated labels. Never keys (`rsi14`), identifiers, hashes, timestamps or links, and never
 * untrusted free text (news, names, descriptions: wrapped or under an untrusted key).
 */
export function collectSourceNumbers(sources: unknown[]): Set<string> {
  const set = new Set<string>();
  const addLabel = (s: string) => {
    const clean = s.replace(UUID_RE, ' ').replace(ISO_TS_RE, ' ').replace(HEX_RE, ' ');
    for (const n of extractNumbers(clean.replace(/[A-Za-z_]+(?=\d)/g, (m) => `${m} `)))
      set.add(n.norm);
  };
  const walk = (v: unknown, key: string) => {
    if (typeof v === 'number' && Number.isFinite(v)) set.add(normaliseNumber(String(v)));
    else if (typeof v === 'string') {
      if (IDENTIFIER_KEY_RE.test(key) || isUntrustedKey(key) || v.includes(UNTRUSTED_OPEN)) return;
      const t = v.trim();
      if (DECIMAL_STRING_RE.test(t)) set.add(normaliseNumber(t));
      else addLabel(t);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k);
  };
  sources.forEach((s) => walk(s, ''));
  return set;
}

// Whole ISO timestamps first, then dates, then clock times; UUIDs are identifiers, not figures.
const TIME_TOKEN_RE =
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}(?::\d{2})?\b/g;

/**
 * Identifiers (UUIDs), dates and clock times the sources carry (from ISO timestamps, including identifier keys such as
 * `barTs`): an answer may say "at 14:00 UTC" or "on 2026-09-25" only when a source has that time.
 */
export function collectSourceTimes(sources: unknown[]): Set<string> {
  const set = new Set<string>();
  const walk = (v: unknown, key: string) => {
    if (typeof v === 'string') {
      if (isUntrustedKey(key) || v.includes(UNTRUSTED_OPEN)) return;
      for (const u of v.matchAll(UUID_RE)) set.add(u[0].toLowerCase());
      for (const m of v.matchAll(
        /(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g,
      )) {
        set.add(m[0]);
        set.add(m[1]!);
        if (m[2]) {
          set.add(`${m[2]}:${m[3]}`);
          set.add(`${Number(m[2])}:${m[3]}`);
          if (m[4]) set.add(`${m[2]}:${m[3]}:${m[4]}`);
        }
      }
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k);
  };
  sources.forEach((s) => walk(s, ''));
  return set;
}

/** A calibrated figure: a rate or probability published by the calibration table with its sample size. */
interface CalibratedFigure {
  value: number;
  n: number;
}

const CALIBRATED_VALUE_KEYS = [
  'value',
  'hitRate',
  'probability',
  'observed',
  'per100',
  'saidAs',
  'meanPredicted',
];

/** Calibrated figures in the sources: any object carrying a sample size `n` and a rate. */
export function collectCalibratedFigures(sources: unknown[]): CalibratedFigure[] {
  const out: CalibratedFigure[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.n === 'number' && o.n > 0)
        for (const k of CALIBRATED_VALUE_KEYS)
          if (typeof o[k] === 'number' && Number.isFinite(o[k]))
            out.push({ value: o[k] as number, n: o.n });
      Object.values(o).forEach(walk);
    }
  };
  sources.forEach(walk);
  return out;
}

const CALIBRATION_WORDS =
  /\b(?:confiden(?:ce|t)|probabilit(?:y|ies)|chances?|likelihood|likely|odds|hit[\s-]*rate|win[\s-]*rate|success[\s-]*rate|accuracy|calibrat\w*|certain(?:ty)?)\b/i;

const NUMBER_WORD =
  '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)';
/** A percentage written in words ("fifty-seven percent"): it cannot be traced to a source. */
const WORD_PERCENT_RE = new RegExp(
  `\\b${NUMBER_WORD}(?:[\\s-]+(?:and[\\s-]+)?${NUMBER_WORD}){0,3}\\s*(?:percent|per\\s*cent|%)`,
  'gi',
);

/** Sentences: a decimal point is not an end, only [.!?] followed by whitespace, or a newline. */
export function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).filter((x) => x.trim() !== '');
}

/**
 * Rule 3 of the system prompt, enforced in code: a percentage stated as a confidence, probability,
 * chance or hit rate must be a calibrated figure from the sources, and its sample size must be given
 * in the same sentence. Returns the offending raw figures.
 */
export function uncalibratedClaims(text: string, sources: unknown[]): string[] {
  const figures = collectCalibratedFigures(sources);
  const bad: string[] = [];
  for (const s of sentencesOf(text)) {
    if (!CALIBRATION_WORDS.test(s)) continue;
    const nums = extractNumbers(s);
    const present = new Set(nums.map((x) => x.norm));
    for (const x of nums) {
      if (!x.percent) continue;
      const ok = figures.some(
        (f) =>
          (roundTo(f.value * 100, x.decimals) === x.norm ||
            roundTo(f.value, x.decimals) === x.norm) &&
          present.has(String(f.n)),
      );
      if (!ok) bad.push(x.raw);
    }
  }
  return bad;
}

function roundTo(value: number, decimals: number): string {
  return normaliseNumber(value.toFixed(decimals));
}

export type FidelityMode = 'exact' | 'rounded';

/**
 * Numbers in `text` that do not trace to a source. Small counting integers (0–10) are allowed.
 * `exact`: the normalised decimal must appear in the sources (a percentage may also be a source
 * fraction × 100, e.g. 57% ↔ 0.57). `rounded` additionally accepts a source rounded to the answer's
 * own decimals (1.08 for 1.0842), never the other way round.
 */
export function ungroundedNumbers(
  text: string,
  sources: unknown[],
  mode: FidelityMode = 'rounded',
): string[] {
  const src = collectSourceNumbers(sources);
  const srcValues = [...src].map(Number).filter((n) => Number.isFinite(n));
  const bad: string[] = [];
  // Dates and clock times are checked as whole tokens against source timestamps, then masked.
  const times = collectSourceTimes(sources);
  const masked = text
    .replace(UUID_RE, (m) => {
      if (!times.has(m.toLowerCase())) bad.push(m);
      return ' ';
    })
    .replace(TIME_TOKEN_RE, (m) => {
      if (!times.has(m)) bad.push(m);
      return ' ';
    });
  for (const n of extractNumbers(masked)) {
    if (Number.isInteger(n.value) && n.value <= 10 && n.decimals === 0) continue;
    if (src.has(n.norm)) continue;
    if (n.percent) {
      const frac = normaliseNumber((n.value / 100).toFixed(Math.max(n.decimals + 2, 2)));
      if (src.has(frac)) continue;
      if (mode === 'rounded' && srcValues.some((s) => roundTo(s * 100, n.decimals) === n.norm))
        continue;
    }
    if (mode === 'rounded' && srcValues.some((s) => roundTo(Math.abs(s), n.decimals) === n.norm))
      continue;
    bad.push(n.raw);
  }
  for (const m of masked.matchAll(WORD_PERCENT_RE)) bad.push(m[0]);
  for (const raw of uncalibratedClaims(masked, sources)) if (!bad.includes(raw)) bad.push(raw);
  return bad;
}

const EXEC_VERBS =
  'placed|submitted|executed|sent|entered|cancell?ed|amended|modified|closed|flattened|started|launched|promoted|bought|sold|opened|filled|activated|switched\\s+on|turned\\s+on|put\\s+(?:it\\s+)?live';
const EXECUTION_CLAIMS: RegExp[] = [
  new RegExp(
    `\\b(?:i|we)(?:\\s+have|'ve|\\s+had|'d)?\\s+(?:just\\s+|now\\s+|already\\s+|successfully\\s+)?(?:(?:gone|went)\\s+ahead\\s+and\\s+)?(?:${EXEC_VERBS})\\b`,
    'i',
  ),
  /\b(?:your|the|an?|this|that)\s+(?:buy\s+|sell\s+|market\s+|limit\s+)?(?:order|trade|position)\s+(?:has\s+been|have\s+been|was|were|is\s+now|is\s+being|got|just\s+got)\s+(?:successfully\s+)?(?:placed|submitted|executed|sent|filled|cancell?ed|amended|modified|closed|opened|entered)\b/i,
  /\b(?:robot|bot|strategy)\s+(?:has\s+been|was|is\s+now|is\s+being)\s+(?:started|launched|promoted|switched\s+on|turned\s+on|activated|put\s+live)\b/i,
  /\b(?:order|trade)\s+(?:placed|submitted|executed|filled)\s*[.!:]/i,
  // "your buy order … is live now", "the order is now active"
  /\b(?:your|the|this)\s+(?:buy\s+|sell\s+)?order\b[^.!?\n]{0,60}\bis\s+(?:now\s+)?(?:live|active|working|in\s+the\s+market)\b/i,
  /\b(?:buy|sell)\s+order\b[^.!?\n]{0,60}\bis\s+(?:now\s+)?(?:live|active)\b/i,
  // "the order went through", "the trade has gone through"
  /\b(?:order|trade)\s+(?:(?:has|have)\s+)?(?:went|gone|go|goes)\s+through\b/i,
  /\b(?:was|were|been|got)\s+filled\s+at\b/i,
];

/** True when the text claims KORA/the copilot acted (checked on normalised, confusable-folded variants). */
export function hasExecutionClaim(text: string): boolean {
  return matchVariants(text).some((v) => EXECUTION_CLAIMS.some((r) => r.test(v)));
}

const TRADE_VERB =
  '(?:buy|sell|trade|invest|short|purchase|go\\s+long|go\\s+short|open|close|enter|exit|add|load\\s+up|get\\s+in|get\\s+out|jump\\s+in)';
const SUGGESTIONS: RegExp[] = [
  new RegExp(
    `\\byou\\s+(?:should|could|might\\s+want\\s+to|may\\s+want\\s+to|ought\\s+to|need\\s+to|must|can)\\s+(?:consider\\s+)?${TRADE_VERB}\\b`,
    'i',
  ),
  /\bi\s+(?:recommend|suggest|advise|would\s+(?:buy|sell|go\s+long|go\s+short))\b/i,
  /\b(?:buy|sell|short|purchase)\s+(?:now|it|this|some|more|today|here|the\s+dip)\b/i,
  /\bgo\s+(?:long|short)\b/i,
  /\b(?:open|enter|take)\s+an?\s+(?:long|short|position|trade)\b/i,
  /\bconsider\s+(?:buying|selling|shorting|purchasing|reducing|increasing|adding)\b/i,
  // "good/great/right time to buy / to get in"
  new RegExp(
    `\\b(?:good|great|right|ideal|perfect|best|smart|excellent)\\s+(?:time|moment|opportunity|entry|chance)\\s+to\\s+${TRADE_VERB}\\b`,
    'i',
  ),
  new RegExp(`\\b(?:time|moment)\\s+to\\s+(?:get\\s+(?:in|out)|jump\\s+in|load\\s+up)\\b`, 'i'),
  // "buying X now is a smart move", "selling is the right call"
  /\b(?:buying|selling|shorting|purchasing)\b[^.!?\n]{0,60}\b(?:smart|good|great|wise|right|sensible|clever)\s+(?:move|idea|call|choice|decision|play|bet)\b/i,
  // "it may be wise to purchase", "worth buying"
  /\b(?:wise|smart|sensible|prudent|advisable|worth|a\s+good\s+idea)\s+(?:to\s+)?(?:buy|sell|purchase|short|invest|buying|selling|purchasing|shorting|investing)\b/i,
  /\bload\s+up\s+on\b/i,
  // Imperative at the start of a sentence: "Buy gold today.", "Purchase some ..."
  /(?:^|[.!?]\s+|\n\s*)(?:buy|sell|purchase|short|invest\s+in|get\s+into|pile\s+into)\s+(?!orders?\b|side\b|price\b|and\b|or\b)[a-z0-9]/i,
];

export function hasTradeSuggestion(text: string): boolean {
  return matchVariants(text).some((v) => SUGGESTIONS.some((r) => r.test(v)));
}

export function withoutDisclaimer(text: string): string {
  return text.replace(/\s*Not investment advice\.?\s*$/i, '').trim();
}

export function ensureDisclaimer(text: string): string {
  const body = withoutDisclaimer(text);
  return `${body}\n\n${DISCLAIMER}`;
}

export const EXECUTION_REFUSAL =
  "I can't place, change or cancel orders, and I can't start or promote robots. I can explain what the data shows or prepare a draft for you to review in the ticket.";

export const NOVICE_FALLBACK =
  'Here is the short version. This screen shows numbers from our practice market, not real money. Prices move up and down all the time. A plan with a stop limits how much you can lose on one trade. Take your time and ask again if something is not clear.';

export interface GuardFlags {
  ungrounded: string[];
  executionClaim: boolean;
  grade: number | null;
  suggestion: boolean;
  fallback: boolean;
}

export interface GuardResult {
  text: string;
  flags: GuardFlags;
}

export function applyGuards(input: {
  text: string;
  mode: AiMode;
  sources: unknown[];
}): GuardResult {
  // IRTC R4-03/R4-04: every check (and the user) sees the normalised text.
  let text = withoutDisclaimer(normaliseText(input.text).trim());
  const flags: GuardFlags = {
    ungrounded: [],
    executionClaim: false,
    grade: null,
    suggestion: false,
    fallback: false,
  };

  if (hasExecutionClaim(input.text) || hasExecutionClaim(text)) {
    flags.executionClaim = true;
    text = EXECUTION_REFUSAL;
  }

  flags.ungrounded = ungroundedNumbers(text, input.sources, 'rounded');
  if (flags.ungrounded.length) {
    const bad = new Set(flags.ungrounded);
    text = text
      .replace(UUID_RE, (m) => (bad.has(m) ? '[unverified]' : m))
      .replace(TIME_TOKEN_RE, (m) => (bad.has(m) ? '[unverified]' : m))
      .replace(WORD_PERCENT_RE, (m) => (bad.has(m) ? '[unverified]' : m))
      .replace(NUM_RE, (m) => (bad.has(m) ? '[unverified]' : m));
    text += '\n\n(Some figures could not be verified against KORA data and were removed.)';
  }

  if (input.mode === 'novice') {
    flags.grade = fleschKincaidGrade(text);
    flags.suggestion = hasTradeSuggestion(input.text) || hasTradeSuggestion(text);
    if (flags.grade > 8 || flags.suggestion || flags.ungrounded.length) {
      flags.fallback = true;
      text = NOVICE_FALLBACK;
    }
  }

  if (!text) text = 'I could not produce an answer from the data available.';
  return { text: ensureDisclaimer(text), flags };
}
