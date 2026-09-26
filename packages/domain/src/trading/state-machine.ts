import type { Decimal } from '../decimal.js';
import { OPEN_ORDER_STATUSES, ORDER_STATUSES, type OrderStatus } from './orders.js';

/**
 * Order state machine (goal 03 §2). The table is the single source of truth: the OMS asserts every
 * transition against it and audits each one as `order.<to>`.
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  new: ['accepted', 'rejected'],
  accepted: ['working', 'cancelled', 'rejected', 'expired'],
  working: ['partially_filled', 'filled', 'cancelled', 'expired'],
  partially_filled: ['partially_filled', 'filled', 'cancelled', 'expired'],
  filled: [],
  cancelled: [],
  rejected: [],
  expired: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: OrderStatus,
    readonly to: OrderStatus,
  ) {
    super(`Order cannot move from ${from} to ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isTerminal(s: OrderStatus): boolean {
  return ORDER_TRANSITIONS[s].length === 0;
}

export function isOpen(s: OrderStatus): boolean {
  return OPEN_ORDER_STATUSES.includes(s);
}

/** Every status reachable from `new` (used by the exhaustiveness test). */
export function reachableFrom(start: OrderStatus = 'new'): Set<OrderStatus> {
  const seen = new Set<OrderStatus>([start]);
  const queue = [start];
  while (queue.length) {
    const s = queue.shift()!;
    for (const n of ORDER_TRANSITIONS[s]) {
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return seen;
}

/** Status after a fill of `filledQty` out of `qty`. */
export function statusAfterFill(filledQty: Decimal, qty: Decimal): OrderStatus {
  if (filledQty.isZero()) return 'working';
  return filledQty.gte(qty) ? 'filled' : 'partially_filled';
}

export const ALL_ORDER_STATUSES = ORDER_STATUSES;
