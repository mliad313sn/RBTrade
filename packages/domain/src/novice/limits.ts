import { dec } from '../decimal.js';

/**
 * Guarded (Novice) limit changes (goal 08 §4): tightening takes effect immediately, loosening waits
 * (24 h by default). Pending loosenings live next to the limits in `accounts.risk_limits.pending`
 * and apply themselves once their time has come, so every process sees the same answer without a
 * scheduler.
 */

/** Limit fields a user may change. `noviceMaxLeverage` = 1 means no borrowing. */
export const GUARDED_LIMIT_FIELDS = [
  'maxOrderNotional',
  'maxPositionNotional',
  'maxLeverage',
  'dailyLossLimit',
  'weeklyLossLimit',
  'monthlyLossLimit',
  'maxOrdersPerMinute',
  'noviceMaxLeverage',
] as const;
export type GuardedLimitField = (typeof GUARDED_LIMIT_FIELDS)[number];

export interface PendingChange {
  value: string;
  requestedAt: string;
  effectiveAt: string;
}

/** Stored JSON: the own limits plus pending loosenings. Values are decimal strings or numbers. */
export interface StoredLimits {
  [field: string]: unknown;
  pending?: Partial<Record<GuardedLimitField, PendingChange>>;
}

const str = (v: unknown): string | undefined =>
  typeof v === 'number' ? String(v) : typeof v === 'string' && v !== '' ? v : undefined;

/**
 * Own limits in effect at `now`: stored values, with pending loosenings whose time has come applied.
 * Returns plain strings (numbers stringified); callers combine them with the platform limits.
 */
export function effectiveOwnLimits(
  stored: StoredLimits | null | undefined,
  now: number,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!stored) return out;
  for (const [k, v] of Object.entries(stored)) {
    if (k === 'pending') continue;
    const s = str(v);
    if (s !== undefined) out[k] = s;
  }
  for (const [k, p] of Object.entries(stored.pending ?? {})) {
    if (p && Date.parse(p.effectiveAt) <= now) out[k] = p.value;
  }
  return out;
}

/** Pending loosenings not yet in effect at `now`. */
export function pendingChanges(
  stored: StoredLimits | null | undefined,
  now: number,
): Array<{ field: GuardedLimitField } & PendingChange> {
  return Object.entries(stored?.pending ?? {})
    .filter(([, p]) => p && Date.parse(p.effectiveAt) > now)
    .map(([field, p]) => ({ field: field as GuardedLimitField, ...(p as PendingChange) }));
}

export interface ChangeOutcome {
  /** New stored JSON (pending entries that came due are folded into the values). */
  stored: StoredLimits;
  applied: Partial<Record<GuardedLimitField, string>>;
  pending: Partial<Record<GuardedLimitField, PendingChange>>;
}

/**
 * Applies requested changes. `current(field)` is the limit in effect now (own limit or platform
 * value); a request above it is a loosening and waits `delayMs` (0 = immediate, e.g. Pro users).
 * A tightening applies now and drops any pending loosening of the same field.
 */
export function applyLimitChanges(
  stored: StoredLimits | null | undefined,
  requested: Partial<Record<GuardedLimitField, string | number>>,
  current: (field: GuardedLimitField) => string | undefined,
  now: number,
  delayMs: number,
): ChangeOutcome {
  // Fold pending changes that already came due into the values first.
  const base = effectiveOwnLimits(stored, now);
  const keep = Object.fromEntries(
    pendingChanges(stored, now).map(({ field, ...p }) => [field, p]),
  ) as Partial<Record<GuardedLimitField, PendingChange>>;
  const next: StoredLimits = { ...base };
  const applied: ChangeOutcome['applied'] = {};
  const pending: ChangeOutcome['pending'] = {};
  for (const [field, raw] of Object.entries(requested) as Array<
    [GuardedLimitField, string | number]
  >) {
    if (raw === undefined) continue;
    const value = String(raw);
    const cur = current(field);
    // No limit in force (undefined) means unlimited: setting one is a tightening.
    const looser = cur !== undefined && dec(value).gt(dec(cur));
    if (looser && delayMs > 0) {
      const p: PendingChange = {
        value,
        requestedAt: new Date(now).toISOString(),
        effectiveAt: new Date(now + delayMs).toISOString(),
      };
      keep[field] = p;
      pending[field] = p;
    } else {
      next[field] = typeof raw === 'number' ? raw : value;
      delete keep[field];
      applied[field] = value;
    }
  }
  if (Object.keys(keep).length) next.pending = keep;
  return { stored: next, applied, pending };
}
