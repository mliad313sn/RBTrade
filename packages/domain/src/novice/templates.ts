import type { StrategyDefinition } from '../strategy/dsl.js';
import { STRATEGY_TEMPLATES, type StrategyTemplate } from '../strategy/templates.js';

/**
 * Auto-invest catalogue for the Novice view (goal 08 §6, B-614): the goal 06 templates with a 1–5
 * risk level and the reasons behind it. The level is a documented rule, not an opinion:
 *   market score = the most volatile market it trades (currencies 1, gold/shares/indices 2, crypto 4)
 *   + 1 when it trades a single market (no spreading)
 *   + 1 when the safety net is a fixed move of 3 % or more (wider swings before it closes)
 * clamped to 1–5. Copy (names, summaries, reasons) lives in the web i18n files by template id.
 */

export type RiskFactor =
  | 'calm_markets'
  | 'mixed_markets'
  | 'crypto_markets'
  | 'single_market'
  | 'wide_safety_net'
  | 'small_amounts';

export const ASSET_CLASS_SCORE: Record<string, number> = {
  fx: 1,
  metal: 2,
  equity: 2,
  etf: 2,
  index: 2,
  cfd: 2,
  fund: 2,
  energy: 3,
  agri: 3,
  crypto: 4,
};

export interface NoviceTemplate {
  id: string;
  riskLevel: 1 | 2 | 3 | 4 | 5;
  factors: RiskFactor[];
  symbols: string[];
  timeframe: string;
  template: StrategyTemplate;
}

export function templateRiskLevel(
  def: StrategyDefinition,
  assetClassOf: (symbol: string) => string,
): { level: 1 | 2 | 3 | 4 | 5; factors: RiskFactor[] } {
  const scores = def.universe.symbols.map((s) => ASSET_CLASS_SCORE[assetClassOf(s)] ?? 3);
  const market = Math.max(...scores);
  const factors: RiskFactor[] = [
    market >= 4 ? 'crypto_markets' : market >= 2 ? 'mixed_markets' : 'calm_markets',
  ];
  let level = market;
  if (def.universe.symbols.length === 1) {
    level += 1;
    factors.push('single_market');
  }
  const stop = def.exit.stop;
  if (stop && stop.kind === 'percent' && typeof stop.pct === 'number' && stop.pct >= 3) {
    level += 1;
    factors.push('wide_safety_net');
  }
  if (def.size.kind === 'risk_pct') factors.push('small_amounts');
  return { level: Math.min(5, Math.max(1, level)) as 1 | 2 | 3 | 4 | 5, factors };
}

/** Asset classes of the template symbols (from the registry seed; the api re-checks with the live registry). */
export const TEMPLATE_ASSET_CLASSES: Record<string, string> = {
  EURUSD: 'fx',
  GBPUSD: 'fx',
  XAUUSD: 'metal',
  BTCUSD: 'crypto',
  ETHUSD: 'crypto',
};

export function noviceTemplates(
  assetClassOf: (symbol: string) => string = (s) => TEMPLATE_ASSET_CLASSES[s] ?? 'cfd',
): NoviceTemplate[] {
  return STRATEGY_TEMPLATES.map((t) => {
    const r = templateRiskLevel(t.definition, assetClassOf);
    return {
      id: t.id,
      riskLevel: r.level,
      factors: r.factors,
      symbols: [...t.definition.universe.symbols],
      timeframe: t.definition.universe.timeframe,
      template: t,
    };
  });
}
