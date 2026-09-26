import { SEED_INSTRUMENTS } from './instruments.js';

/**
 * Vendor symbol aliases for the stub adapters (`instrument_aliases` table). Lets any provider's
 * naming map onto the internal registry symbol without touching the registry itself.
 */
export interface InstrumentAlias {
  source: string;
  vendorSymbol: string;
  symbol: string;
}

export const SEED_ALIASES: InstrumentAlias[] = [
  ...SEED_INSTRUMENTS.filter((i) => i.assetClass === 'fx' || i.assetClass === 'metal').map((i) => ({
    source: 'broker-fxcfd',
    vendorSymbol: `${i.baseCcy}_${i.quoteCcy}`,
    symbol: i.symbol,
  })),
  ...SEED_INSTRUMENTS.filter((i) => i.assetClass === 'crypto').map((i) => ({
    source: 'crypto-testnet',
    vendorSymbol: `${i.baseCcy}USDT`,
    symbol: i.symbol,
  })),
  ...SEED_INSTRUMENTS.filter((i) => (i.assetClass === 'equity' || i.assetClass === 'etf') && ['XNAS', 'XNYS', 'ARCX'].includes(i.venue)).map((i) => ({
    source: 'equities-provider',
    vendorSymbol: i.symbol,
    symbol: i.symbol,
  })),
];

export function aliasMap(source: string, aliases: InstrumentAlias[] = SEED_ALIASES): Record<string, string> {
  return Object.fromEntries(aliases.filter((a) => a.source === source).map((a) => [a.vendorSymbol, a.symbol]));
}
