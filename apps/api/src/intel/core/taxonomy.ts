import type { AssetClass } from '@kora/domain';

/**
 * Market Radar taxonomy (goal 07B). Continents group the registry's venue regions; sectors are
 * SIMULATED labels for the seeded instruments (a licensed classification is part of the reference
 * data request, OQ-M2), with a per-asset-class default for everything else.
 */
export const RADAR_REGIONS = ['americas', 'europe', 'africa', 'asia', 'oceania', 'global'] as const;
export type RadarRegion = (typeof RADAR_REGIONS)[number];

export const REGION_LABELS: Record<RadarRegion, string> = {
  americas: 'Americas',
  europe: 'Europe',
  africa: 'Africa',
  asia: 'Asia',
  oceania: 'Oceania',
  global: 'Global OTC',
};

export function radarRegion(venueRegion: string): RadarRegion {
  if (venueRegion === 'north_america' || venueRegion === 'south_america') return 'americas';
  if ((RADAR_REGIONS as readonly string[]).includes(venueRegion)) return venueRegion as RadarRegion;
  return 'global';
}

const SECTOR_BY_SYMBOL: Record<string, string> = {
  AAPL: 'technology',
  NVDA: 'technology',
  MSFT: 'technology',
  AMZN: 'consumer',
  TSLA: 'consumer',
  GOOGL: 'communication',
  '7203.XTKS': 'consumer',
  '0700.XHKG': 'communication',
  '600519.XSHG': 'consumer',
  'RELIANCE.XNSE': 'energy',
  'NPN.XJSE': 'communication',
  'PETR4.BVMF': 'energy',
  'BHP.XASX': 'materials',
  'AIR.XNZE': 'industrials',
  'HSBA.XLON': 'financials',
  'SAP.XETR': 'technology',
  'MC.XPAR': 'consumer',
  'SHOP.XTSE': 'technology',
};

const SECTOR_BY_CLASS: Record<AssetClass, string> = {
  equity: 'other_equity',
  etf: 'broad_market',
  bond: 'rates',
  future: 'broad_market',
  option: 'broad_market',
  fx: 'currencies',
  metal: 'metals',
  energy: 'energy',
  agri: 'agriculture',
  crypto: 'crypto',
  index: 'broad_market',
  cfd: 'broad_market',
  fund: 'multi_asset',
};

export const SECTORS = [
  'technology',
  'communication',
  'consumer',
  'financials',
  'energy',
  'materials',
  'industrials',
  'other_equity',
  'broad_market',
  'rates',
  'currencies',
  'metals',
  'agriculture',
  'crypto',
  'multi_asset',
] as const;

export function sectorOf(symbol: string, assetClass: AssetClass): string {
  return SECTOR_BY_SYMBOL[symbol] ?? SECTOR_BY_CLASS[assetClass];
}

/** Horizons of the trend forecasts, in bars of the scan timeframe (1 h bars by default). */
export interface Horizon {
  label: string;
  bars: number;
}

export function parseHorizons(raw: string | undefined): Horizon[] {
  const out: Horizon[] = [];
  for (const part of (raw ?? '1d:24,1w:120,1m:480').split(',')) {
    const [label, bars] = part.split(':').map((s) => s.trim());
    const n = Number(bars);
    if (label && /^[0-9a-z]{1,8}$/.test(label) && Number.isInteger(n) && n > 0)
      out.push({ label, bars: n });
  }
  return out.length ? out : [{ label: '1d', bars: 24 }];
}

export const TREND_MODEL = 'logit';

/** Calibration-table key of a trend forecast (goal 07 `ai_predictions` / `ai_calibration_bins`). */
export function trendModelKey(region: RadarRegion, horizon: string): string {
  return `trend:${TREND_MODEL}:${region}:${horizon}`;
}

/** Plain labels of the scanner features (the numbers themselves always come from the scan). */
export const FEATURE_LABELS: Record<string, string> = {
  adx: 'Trend strength (ADX 14)',
  atr: 'Average true range (14)',
  slope_t: 'Slope t-stat (20 bars)',
  regime_trending: 'Regime: trending (probability)',
  regime_ranging: 'Regime: ranging (probability)',
  regime_volatile: 'Regime: volatile (probability)',
  breakout: 'Breakout vs 20-bar channel',
  channel_pos: 'Position in 20-bar channel',
  bb_width_pct: 'Band-width percentile (compression)',
  atr_ratio: 'ATR vs 100-bar mean range',
  mom_z: 'Momentum z-score (20 bars)',
  mr_z: 'Distance from 20-bar mean (z)',
  rs_sector: 'Relative strength vs sector',
  rs_index: 'Relative strength vs region',
  corr_break: 'Correlation break vs region',
  volume_z: 'Volume anomaly (z)',
  vol_ratio: 'Volatility ratio (20/100)',
  ret_z: 'Last bar return (z)',
  season_t: 'Hour-of-day seasonality (t)',
  event_minutes: 'Minutes to next high-impact event',
};

export const TREND_KIND_LABELS: Record<string, string> = {
  up: 'Uptrend',
  down: 'Downtrend',
  range: 'Range',
  breakout_up: 'Breakout up',
  breakout_down: 'Breakout down',
  reversal: 'Reversal',
  vol_regime: 'Volatility regime',
};
