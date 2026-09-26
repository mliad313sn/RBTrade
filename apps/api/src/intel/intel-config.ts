import { TIMEFRAMES, type Timeframe } from '@kora/domain';

import { parseHorizons, type Horizon } from './core/taxonomy';

/** Goal 07B configuration, read from env on every call (tests switch it at runtime). */
export interface IntelConfig {
  /** Bar-close scans on a timer (`on`); `off` = only on demand (tests, or quant not running). */
  scan: boolean;
  scanCheckMs: number;
  timeframe: Timeframe;
  bars: number;
  horizons: Horizon[];
  minTrain: number;
  guardCheckpoints: number;
  news: boolean;
  newsIntervalMs: number;
  /** Goal 06 `ai_regime` hook: `model` reads the scanner's regime filter, `off` keeps not_available. */
  aiRegime: 'model' | 'off';
}

const int = (v: string | undefined, d: number, min: number, max: number) => {
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && Number.isInteger(n) && n >= min && n <= max ? n : d;
};

export function loadIntelConfig(e: NodeJS.ProcessEnv = process.env): IntelConfig {
  const env = e.KORA_ENV ?? 'dev';
  const tf = (e.KORA_INTEL_TIMEFRAME ?? '1h') as Timeframe;
  return {
    scan: (e.KORA_INTEL_SCAN ?? (env === 'test' ? 'off' : 'on')) === 'on',
    scanCheckMs: int(e.KORA_INTEL_SCAN_CHECK_MS, 60_000, 1_000, 3_600_000),
    timeframe: (TIMEFRAMES as readonly string[]).includes(tf) && tf !== '1s' ? tf : '1h',
    bars: int(e.KORA_INTEL_BARS, 1000, 50, 5000),
    horizons: parseHorizons(e.KORA_INTEL_HORIZONS),
    minTrain: int(e.KORA_INTEL_MIN_TRAIN, 200, 50, 10_000),
    guardCheckpoints: int(e.KORA_INTEL_GUARD_CHECKPOINTS, 2, 1, 20),
    news: (e.KORA_INTEL_NEWS ?? (env === 'test' ? 'off' : 'on')) === 'on',
    newsIntervalMs: int(e.KORA_INTEL_NEWS_INTERVAL_MS, 900_000, 10_000, 86_400_000),
    aiRegime: e.KORA_AI_REGIME === 'off' ? 'off' : 'model',
  };
}
