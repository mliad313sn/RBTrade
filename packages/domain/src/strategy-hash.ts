import { createHash } from 'node:crypto';

import { canonicalStrategyJson } from './strategy/canonical.js';
import type { StrategyDefinition } from './strategy/dsl.js';

/** SHA-256 (hex) of the canonical JSON of a validated strategy definition (node only). */
export function strategyContentHash(def: StrategyDefinition): string {
  return createHash('sha256').update(canonicalStrategyJson(def)).digest('hex');
}

/** Stable hash of a parameter assignment (trial identity for overfitting controls). */
export function paramsHash(values: Record<string, number>): string {
  return createHash('sha256').update(canonicalStrategyJson(values)).digest('hex');
}
