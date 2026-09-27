/**
 * Promotion evidence rules (IRTC R3-02). A backtest counts as promotion evidence only when the
 * server chose everything that could be tuned after seeing results: the strategy's own universe and
 * parameters, all available history, the default out-of-sample holdout and the registry costs. The
 * holdout's Sharpe is then deflated by every trial recorded for the strategy at the time of the check.
 *
 * Policy values decided by the Product Owner (delegated Sponsor authority), docs/open-questions.md
 * OQ-R8a: DSR ≥ 0.95 on the holdout and ≥ 90 daily observations in it.
 */
import { deflatedSharpe, trialSharpeVariance } from './dsr.js';

/** The only out-of-sample share accepted for promotion evidence (the product default). */
export const EVIDENCE_OOS_FRACTION = 0.3;

export type EvidenceIneligibility =
  | 'not_a_backtest'
  | 'symbols_override'
  | 'custom_window'
  | 'custom_split'
  | 'param_overrides'
  | 'cost_override';

export interface EvidenceRequest {
  symbols?: string[];
  from?: number;
  to?: number;
  split?: { oosStart?: number; oosFraction?: number };
  paramOverrides?: Record<string, number>;
  spreadTicks?: number;
}

export function evidenceEligibility(
  kind: string,
  req: EvidenceRequest,
  universe: readonly string[],
): { eligible: boolean; reasons: EvidenceIneligibility[] } {
  const reasons: EvidenceIneligibility[] = [];
  if (kind !== 'backtest') reasons.push('not_a_backtest');
  if (req.symbols && [...req.symbols].sort().join(',') !== [...universe].sort().join(','))
    reasons.push('symbols_override');
  if (req.from !== undefined || req.to !== undefined) reasons.push('custom_window');
  if (
    req.split?.oosStart !== undefined ||
    (req.split?.oosFraction ?? EVIDENCE_OOS_FRACTION) !== EVIDENCE_OOS_FRACTION
  )
    reasons.push('custom_split');
  if (Object.keys(req.paramOverrides ?? {}).length > 0) reasons.push('param_overrides');
  if (req.spreadTicks !== undefined) reasons.push('cost_override');
  return { eligible: reasons.length === 0, reasons };
}

/** Holdout moments stored in a backtest summary (per-period = daily returns). */
export interface HoldoutMoments {
  oosSharpe: number | null;
  oosTrades: number;
  oosPeriodSharpe: number | null;
  oosObservations: number;
  oosSkew: number | null;
  oosKurtosis: number | null;
}

export function holdoutDeflatedSharpe(
  m: HoldoutMoments | null,
  trials: { count: number; periodSharpes: readonly number[] },
): { dsr: number | null; sr0: number; trials: number; variance: number } {
  const n = Math.max(1, trials.count);
  const variance = trialSharpeVariance(trials.periodSharpes);
  if (
    !m ||
    m.oosPeriodSharpe === null ||
    m.oosSkew === null ||
    m.oosKurtosis === null ||
    m.oosObservations < 2
  )
    return { dsr: null, sr0: 0, trials: n, variance };
  const { dsr, sr0 } = deflatedSharpe(
    m.oosPeriodSharpe,
    m.oosObservations,
    m.oosSkew,
    m.oosKurtosis,
    n,
    variance,
  );
  return { dsr, sr0, trials: n, variance };
}
