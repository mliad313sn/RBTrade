export const ACTOR_TYPES = ['user', 'robot', 'ai', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const GENESIS_HASH = '0'.repeat(64);

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export interface AuditEvent {
  id: string; // bigint as string
  ts: string; // ISO-8601 UTC with microseconds
  actorId: string;
  actorType: ActorType;
  action: string;
  entity: string;
  entityId: string | null;
  payload: JsonValue;
  prevHash: string;
  hash: string;
}

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

/**
 * Canonical JSON used for audit hashing: sorted keys, no whitespace, only safe integers as numbers.
 * Non-integer numbers are rejected: decimals travel as strings (money rule).
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      if (value.includes('\u0000')) throw new CanonicalJsonError('NUL character not allowed');
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw new CanonicalJsonError(
          `Non-integer or unsafe number ${value} in audit payload: send decimals as strings`,
        );
      }
      return String(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalJsonError('Only plain objects are allowed in audit payloads');
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    default:
      throw new CanonicalJsonError(`Unsupported type ${typeof value} in audit payload`);
  }
}

export interface ChainVerification {
  valid: boolean;
  count: number;
  firstBrokenId: string | null;
  reason: 'hash_mismatch' | 'prev_hash_mismatch' | 'id_gap' | null;
  headHash: string;
}
