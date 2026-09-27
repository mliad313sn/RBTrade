import { normaliseText } from './normalise';
import { redactPii } from './pii';
import type { UntrustedInput } from './types';

/**
 * Untrusted text (news, calendar descriptions, user notes, strategy and robot names) is wrapped as
 * data between delimiters the system prompt names. Anything that could close or fake a delimiter is
 * neutralised by replacing its angle brackets, so the data cannot escape the wrapper whatever it
 * contains.
 *
 * IRTC R4-14: the text is NFKC-normalised first (full-width `＜` becomes `<`), invisible characters
 * are removed, and *any* tag-like sequence (`<` then optional `/` then a letter, in any script) is
 * neutralised, so homoglyph (`</untrusted_datа>`), hyphen (`</untrusted-data>`) and unknown tag
 * names (`</tool_result>`) cannot fake a delimiter either. Plain comparisons (`1 < 2`, `ADX > 22`)
 * are left alone.
 */
const TAG_LOOKALIKE = /<\s*\/?\s*[\p{L}_!?][^<>\n]{0,200}>?/gu;

export const UNTRUSTED_OPEN = '<untrusted_data';

export function neutralise(text: string): string {
  return normaliseText(text).replace(TAG_LOOKALIKE, (m) => m.replace(/</g, '‹').replace(/>/g, '›'));
}

const ATTR_SAFE = /[^a-zA-Z0-9_.:-]/g;

/** IRTC R4-11: untrusted blocks (screen text, notes) are PII-redacted like the question. */
export function wrapUntrusted(input: UntrustedInput, maxChars = 4000): string {
  const body = neutralise(redactPii(input.text, { keepUuids: true })).slice(0, maxChars);
  const id = input.id ? ` id="${input.id.replace(ATTR_SAFE, '').slice(0, 64)}"` : '';
  return `<untrusted_data source="${input.source}"${id}>\n${body}\n</untrusted_data>`;
}

/**
 * IRTC R4-05: keys whose string values are free text from outside KORA (users, news, providers) in
 * any tool output or grounding. Always wrapped, whatever the tool spec lists.
 */
export const DEFAULT_UNTRUSTED_KEYS: readonly string[] = [
  'name',
  'robotName',
  'strategyName',
  'displayName',
  'title',
  'translatedTitle',
  'originalTitle',
  'summary',
  'description',
  'reason',
  'rationale',
  'note',
  'notes',
  'comment',
  'text',
  'body',
  'content',
  'source',
  'url',
  'author',
  'headline',
];

/**
 * KORA-generated sentences that may be long but are never user or provider text (statements built
 * from templates in code).
 */
const KORA_TEXT_KEYS: readonly string[] = [
  'message',
  'edgeStatement',
  'reliabilityLine',
  'label',
  'statement',
  'rule',
  'disclaimer',
  'environment',
];

/** Strings longer than this (or multi-line) are free text: wrapped unless the key is KORA's own. */
const FREE_TEXT_CHARS = 120;

export function isUntrustedKey(key: string, extra: readonly string[] = []): boolean {
  return DEFAULT_UNTRUSTED_KEYS.includes(key) || extra.includes(key);
}

function isFreeText(key: string, value: string): boolean {
  if (KORA_TEXT_KEYS.includes(key)) return false;
  return value.length > FREE_TEXT_CHARS || value.includes('\n');
}

/**
 * Tool outputs and grounding are JSON. String leaves under an untrusted key (the defaults plus the
 * tool's own list), and any long free-text string under a key that is not a KORA template, are
 * wrapped; every string leaf is neutralised.
 */
export function sanitiseToolOutput(
  value: unknown,
  untrustedKeys: readonly string[] = [],
  key = '',
): unknown {
  if (typeof value === 'string') {
    const clean = neutralise(value);
    return isUntrustedKey(key, untrustedKeys) || isFreeText(key, clean)
      ? `<untrusted_data source="tool:${key.replace(ATTR_SAFE, '').slice(0, 64)}">${clean}</untrusted_data>`
      : clean;
  }
  if (Array.isArray(value)) return value.map((v) => sanitiseToolOutput(v, untrustedKeys, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        sanitiseToolOutput(v, untrustedKeys, k),
      ]),
    );
  }
  return value;
}
