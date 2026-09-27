import type { AssetClass, InstrumentSpec } from '@kora/domain';

/**
 * Simulator parameters (not registry data). Reference prices are SIMULATED starting levels chosen
 * to resemble the prototype artboard; they are not market data. Any instrument without an explicit
 * profile gets an asset-class default, so the simulator can generate for every registry row.
 */
export interface SimProfile {
  /** Starting level (decimal string, rounded to the registry tick at use). */
  refPrice: string;
  /** Annualised volatility (float, simulator-internal). */
  annualVol: number;
  /** Typical spread in ticks. */
  spreadTicks: number;
  /** Mean trades per second. */
  tradeRate: number;
  /** Emit a quote every N steps (funds tick rarely). */
  quoteEveryNSteps: number;
  /** Depth size scale in multiples of min qty. */
  depthScale: number;
}

const CLASS_DEFAULTS: Record<AssetClass, Omit<SimProfile, 'refPrice'>> = {
  fx: { annualVol: 0.08, spreadTicks: 3, tradeRate: 3, quoteEveryNSteps: 1, depthScale: 1000 },
  metal: { annualVol: 0.15, spreadTicks: 20, tradeRate: 2, quoteEveryNSteps: 1, depthScale: 20 },
  crypto: { annualVol: 0.6, spreadTicks: 5, tradeRate: 5, quoteEveryNSteps: 1, depthScale: 5000 },
  equity: { annualVol: 0.3, spreadTicks: 2, tradeRate: 2, quoteEveryNSteps: 1, depthScale: 5 },
  etf: { annualVol: 0.18, spreadTicks: 1, tradeRate: 3, quoteEveryNSteps: 1, depthScale: 20 },
  bond: { annualVol: 0.06, spreadTicks: 2, tradeRate: 0.5, quoteEveryNSteps: 1, depthScale: 10 },
  future: { annualVol: 0.2, spreadTicks: 1, tradeRate: 3, quoteEveryNSteps: 1, depthScale: 10 },
  option: { annualVol: 0.9, spreadTicks: 2, tradeRate: 0.5, quoteEveryNSteps: 1, depthScale: 10 },
  energy: { annualVol: 0.35, spreadTicks: 3, tradeRate: 2, quoteEveryNSteps: 1, depthScale: 20 },
  agri: { annualVol: 0.25, spreadTicks: 2, tradeRate: 1, quoteEveryNSteps: 1, depthScale: 10 },
  index: { annualVol: 0.18, spreadTicks: 5, tradeRate: 3, quoteEveryNSteps: 1, depthScale: 10 },
  cfd: { annualVol: 0.18, spreadTicks: 5, tradeRate: 3, quoteEveryNSteps: 1, depthScale: 10 },
  fund: {
    annualVol: 0.12,
    spreadTicks: 1,
    tradeRate: 0.02,
    quoteEveryNSteps: 600,
    depthScale: 100,
  },
};

const REF: Record<string, string> = {
  EURUSD: '1.08420',
  GBPUSD: '1.26412',
  USDJPY: '148.215',
  USDCHF: '0.88150',
  AUDUSD: '0.66420',
  USDCAD: '1.35870',
  NZDUSD: '0.61230',
  EURGBP: '0.85770',
  EURJPY: '160.690',
  GBPJPY: '187.360',
  USDHKD: '7.81200',
  USDCNY: '7.18500',
  USDINR: '83.45000',
  USDZAR: '18.25000',
  USDBRL: '5.45000',
  XAUUSD: '2395.40',
  XAGUSD: '28.415',
  BTCUSD: '64812.5',
  ETHUSD: '3104.20',
  SOLUSD: '145.30',
  XRPUSD: '0.5820',
  US500: '5482.6',
  NAS100: '19640.1',
  US30: '39120',
  GER40: '18450.5',
  UK100: '8240.3',
  JPN225: '38740',
  AAPL: '221.37',
  NVDA: '118.92',
  MSFT: '428.15',
  AMZN: '186.40',
  TSLA: '243.10',
  GOOGL: '162.85',
  WTI: '78.14',
  BRENT: '82.30',
  NATGAS: '2.614',
  '7203.XTKS': '2805.5',
  '0700.XHKG': '372.4',
  '600519.XSHG': '1480.00',
  'RELIANCE.XNSE': '2950.05',
  'NPN.XJSE': '3450.00',
  'PETR4.BVMF': '37.85',
  'BHP.XASX': '43.20',
  'AIR.XNZE': '0.555',
  'HSBA.XLON': '684.2',
  'SAP.XETR': '202.40',
  'MC.XPAR': '648.3',
  'SHOP.XTSE': '104.20',
  SPY: '548.20',
  ESZ6: '5510.25',
  ZCZ6: '4.1225',
  SPY261218C550: '12.45',
  UST10Y: '98.515625',
  KGEF: '10.2345',
  'N225.IDX': '38712.45',
  WHEAT: '5.6150',
};

const OVERRIDES: Record<string, Partial<SimProfile>> = {
  EURUSD: { spreadTicks: 2 },
  USDJPY: { spreadTicks: 3 },
  BTCUSD: { spreadTicks: 10 },
  US500: { spreadTicks: 4 },
  JPN225: { spreadTicks: 2 },
};

/** Profile for any registry instrument; `refPrice` falls back to a tick-aligned default. */
export function simProfileFor(
  spec: Pick<InstrumentSpec, 'symbol' | 'assetClass' | 'tickSize'>,
): SimProfile {
  const base = CLASS_DEFAULTS[spec.assetClass];
  const refPrice = REF[spec.symbol] ?? (spec.assetClass === 'fx' ? '1' : '100');
  return { ...base, refPrice, ...OVERRIDES[spec.symbol] };
}
