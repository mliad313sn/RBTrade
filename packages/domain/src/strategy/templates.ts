import type { StrategyDefinition } from './dsl.js';

/**
 * Strategy templates. Trend-X mirrors the prototype (Robots artboard). Templates are the only thing
 * novice users see (goal 08, through `GET /strategy-templates`); traders and quants start the
 * builder from them. All figures are illustrative defaults, not recommendations.
 */
export interface StrategyTemplate {
  id: string;
  name: string;
  /** Plain-language summary (no jargon) for the Novice view. */
  summary: string;
  /** How much the result can swing, in plain words. */
  riskLevel: 'lower' | 'medium' | 'higher';
  definition: StrategyDefinition;
}

export const TREND_X: StrategyDefinition = {
  schema: 'kora.strategy',
  schemaVersion: 1,
  name: 'Trend-X',
  description:
    'FX + gold 1h trend follower: EMA cross confirmed by ADX, outside high-impact events.',
  universe: { symbols: ['EURUSD', 'GBPUSD', 'XAUUSD'], timeframe: '1h' },
  params: {
    fast: { value: 20, min: 5, max: 60, step: 5, integer: true, label: 'Fast EMA' },
    slow: { value: 50, min: 20, max: 200, step: 10, integer: true, label: 'Slow EMA' },
    adx_min: { value: 22, min: 10, max: 40, step: 2, integer: false, label: 'ADX threshold' },
    stop_atr: { value: 1.5, min: 0.5, max: 4, step: 0.25, integer: false, label: 'Stop × ATR' },
    target_atr: { value: 3, min: 1, max: 8, step: 0.5, integer: false, label: 'Target × ATR' },
    trail_r: { value: 1, min: 0.5, max: 3, step: 0.5, integer: false, label: 'Trail after R' },
    risk_pct: { value: 0.75, min: 0.1, max: 2, step: 0.05, integer: false, label: 'Risk % equity' },
  },
  entry: {
    side: 'long',
    conditions: [
      {
        type: 'cross',
        id: 'ema-cross',
        left: { kind: 'indicator', name: 'ema', period: { param: 'fast' } },
        direction: 'above',
        right: { kind: 'indicator', name: 'ema', period: { param: 'slow' } },
      },
      {
        type: 'compare',
        id: 'adx',
        left: { kind: 'indicator', name: 'adx', period: 14 },
        op: 'gt',
        right: { kind: 'const', value: { param: 'adx_min' } },
      },
      {
        type: 'ai_regime',
        id: 'regime',
        regime: 'trending',
        minProbability: 0.6,
        whenUnavailable: 'ignore',
      },
    ],
  },
  filters: [{ type: 'no_event', id: 'no-event', withinMinutes: 60, impact: 'high' }],
  exit: {
    stop: { kind: 'atr', multiple: { param: 'stop_atr' }, period: 14 },
    target: { kind: 'atr', multiple: { param: 'target_atr' }, period: 14 },
    trailing: {
      afterR: { param: 'trail_r' },
      kind: 'atr',
      multiple: { param: 'stop_atr' },
      period: 14,
    },
    conditions: [],
  },
  size: { kind: 'risk_pct', pct: { param: 'risk_pct' }, maxOpenPositions: 3 },
};

export const MEANREV_GOLD: StrategyDefinition = {
  schema: 'kora.strategy',
  schemaVersion: 1,
  name: 'MeanRev-Gold',
  description: 'Gold 15m mean reversion: buy oversold RSI, exit when it recovers.',
  universe: { symbols: ['XAUUSD'], timeframe: '15m' },
  params: {
    rsi_len: { value: 14, min: 5, max: 30, step: 1, integer: true, label: 'RSI length' },
    oversold: { value: 30, min: 10, max: 40, step: 5, integer: false, label: 'Oversold' },
    recovered: { value: 55, min: 45, max: 70, step: 5, integer: false, label: 'Exit RSI' },
  },
  entry: {
    side: 'long',
    conditions: [
      {
        type: 'compare',
        id: 'rsi-low',
        left: { kind: 'indicator', name: 'rsi', period: { param: 'rsi_len' } },
        op: 'lt',
        right: { kind: 'const', value: { param: 'oversold' } },
      },
    ],
  },
  filters: [{ type: 'venue_open', id: 'open' }],
  exit: {
    stop: { kind: 'atr', multiple: 2, period: 14 },
    target: { kind: 'r', multiple: 1.5 },
    timeStopBars: 32,
    conditions: [
      {
        type: 'compare',
        id: 'rsi-back',
        left: { kind: 'indicator', name: 'rsi', period: { param: 'rsi_len' } },
        op: 'gt',
        right: { kind: 'const', value: { param: 'recovered' } },
      },
    ],
  },
  size: { kind: 'risk_pct', pct: 0.5, maxOpenPositions: 1 },
};

export const BREAKOUT_CRYPTO: StrategyDefinition = {
  schema: 'kora.strategy',
  schemaVersion: 1,
  name: 'Breakout-Crypto',
  description: 'BTC and ETH 4h breakout above the prior 20-bar high, volatility-targeted size.',
  universe: { symbols: ['BTCUSD', 'ETHUSD'], timeframe: '4h' },
  params: {
    lookback: { value: 20, min: 10, max: 60, step: 5, integer: true, label: 'Breakout bars' },
    target_vol: { value: 20, min: 5, max: 60, step: 5, integer: false, label: 'Target vol %' },
  },
  entry: {
    side: 'long',
    conditions: [
      {
        type: 'compare',
        id: 'breakout',
        left: { kind: 'indicator', name: 'close' },
        op: 'gt',
        right: { kind: 'indicator', name: 'highest', period: { param: 'lookback' } },
      },
    ],
  },
  filters: [],
  exit: {
    stop: { kind: 'percent', pct: 4 },
    trailing: { afterR: 1, kind: 'atr', multiple: 2, period: 14 },
    timeStopBars: 60,
    conditions: [],
  },
  size: {
    kind: 'vol_target',
    annualVolPct: { param: 'target_vol' },
    lookback: 30,
    maxOpenPositions: 2,
  },
};

export const STRATEGY_TEMPLATES: readonly StrategyTemplate[] = [
  {
    id: 'trend-x',
    name: 'Trend-X',
    summary: 'Follows a price move once it has clearly started, and steps aside around big news.',
    riskLevel: 'medium',
    definition: TREND_X,
  },
  {
    id: 'meanrev-gold',
    name: 'MeanRev-Gold',
    summary: 'Buys gold after a sharp dip and sells once the price has settled back.',
    riskLevel: 'medium',
    definition: MEANREV_GOLD,
  },
  {
    id: 'breakout-crypto',
    name: 'Breakout-Crypto',
    summary:
      'Buys bitcoin or ether when the price breaks above its recent range, with smaller amounts when prices swing more.',
    riskLevel: 'higher',
    definition: BREAKOUT_CRYPTO,
  },
];
