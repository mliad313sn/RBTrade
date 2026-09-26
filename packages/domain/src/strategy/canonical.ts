/**
 * Canonical JSON for strategy definitions: sorted keys, no whitespace, `undefined` dropped, finite
 * numbers in JavaScript's shortest round-trip form. Unlike the audit canonicaliser, fractional
 * numbers are allowed (ATR multiples, risk %), which is safe because the hash is only ever computed
 * by the api from a validated definition.
 */
export function canonicalStrategyJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new Error('Non-finite number in a strategy definition');
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalStrategyJson(v)).join(',')}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalStrategyJson(v)}`).join(',')}}`;
    }
    default:
      throw new Error(`Unsupported type ${typeof value} in a strategy definition`);
  }
}

/** Short form shown in the UI (prototype: `params #a41f9c`). */
export function shortHash(contentHash: string): string {
  return `#${contentHash.slice(0, 6)}`;
}
