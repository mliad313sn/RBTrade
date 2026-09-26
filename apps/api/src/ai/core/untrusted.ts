import type { UntrustedInput } from './types';

/**
 * Untrusted text (news, calendar descriptions, user notes, strategy and robot names) is wrapped as
 * data between delimiters the system prompt names. Anything that could close or fake a delimiter
 * (`<untrusted_data`, `</untrusted_data>`, `<tool_output`, `<context`, `<system`) is neutralised by
 * replacing its angle brackets, so the data cannot escape the wrapper whatever it contains.
 */
const TAG_LOOKALIKE =
  /<\s*\/?\s*(untrusted_data|tool_output|context|grounding|question|system|instructions?|user|assistant|human)\b[^>]*>?/gi;

// Control characters and invisible direction/zero-width marks are removed (built from code points
// so the source stays free of irregular characters).
const INVISIBLE = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}${String.fromCharCode(12)}${String.fromCharCode(14)}-${String.fromCharCode(31)}${String.fromCharCode(127)}${String.fromCharCode(0x200b)}-${String.fromCharCode(0x200f)}${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}]`,
  'g',
);

export function neutralise(text: string): string {
  return text
    .replace(TAG_LOOKALIKE, (m) => m.replace(/</g, '‹').replace(/>/g, '›'))
    .replace(INVISIBLE, '');
}

const ATTR_SAFE = /[^a-zA-Z0-9_.:-]/g;

export function wrapUntrusted(input: UntrustedInput, maxChars = 4000): string {
  const body = neutralise(input.text).slice(0, maxChars);
  const id = input.id ? ` id="${input.id.replace(ATTR_SAFE, '').slice(0, 64)}"` : '';
  return `<untrusted_data source="${input.source}"${id}>\n${body}\n</untrusted_data>`;
}

/**
 * Tool outputs are JSON. String leaves named in `untrustedKeys` (free text from outside KORA) are
 * wrapped; every string leaf is neutralised.
 */
export function sanitiseToolOutput(
  value: unknown,
  untrustedKeys: readonly string[] = [],
  key = '',
): unknown {
  if (typeof value === 'string') {
    const clean = neutralise(value);
    return untrustedKeys.includes(key)
      ? `<untrusted_data source="tool:${key}">${clean}</untrusted_data>`
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
