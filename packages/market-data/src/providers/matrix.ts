import { ASSET_CLASSES, type AssetClass, type Region } from '@kora/domain';

import { STUB_FLAGS, type StubSource } from '../stubs/factory.js';

/**
 * Provider adapter matrix (goal 07B §1): which data source would serve each continent, for market
 * data and for news. Every entry is a **flagged stub**: no licence is signed, the live transport
 * refuses to connect, and all data in KORA is SIMULATED until the Sponsor signs a licensed data
 * contract (OQ-M3 market data, OQ-M4 news). Entries describe the kind of source needed, not a
 * vendor; the licensing need is spelled out so the Sponsor can procure it.
 */

export const CONTINENTS = ['americas', 'europe', 'africa', 'asia', 'oceania'] as const;
export type Continent = (typeof CONTINENTS)[number];

/** Registry regions grouped by continent; `global` (KORA's simulated OTC venues) stays global. */
export function continentOf(region: Region): Continent | 'global' {
  if (region === 'north_america' || region === 'south_america') return 'americas';
  if (region === 'global') return 'global';
  return region;
}

export interface ProviderEntry {
  id: string;
  kind: 'market_data' | 'news';
  description: string;
  continents: readonly Continent[];
  /** ISO 10383 MICs of seeded venues this source would cover (market data). */
  venues: readonly string[];
  assetClasses: readonly AssetClass[];
  /** Adapter in code: a goal 02 stub source, the goal 07B news stub, or null (not written yet). */
  adapter: StubSource | `news:${string}` | null;
  /** Feature flag that enables the stub (the live transport still refuses). */
  flag: string;
  flagged: true;
  licensed: false;
  languages?: readonly string[];
  licensingNeed: string;
  openQuestion: 'OQ-M3' | 'OQ-M4';
}

const MD = 'OQ-M3' as const;
const NEWS = 'OQ-M4' as const;

export const PROVIDER_MATRIX: readonly ProviderEntry[] = [
  {
    id: 'md-americas-equities',
    kind: 'market_data',
    description: 'Consolidated North and South American equities, ETFs, options and index levels',
    continents: ['americas'],
    venues: ['XNYS', 'XNAS', 'ARCX', 'XCBO', 'XTSE', 'BVMF'],
    assetClasses: ['equity', 'etf', 'option', 'index', 'fund'],
    adapter: 'equities-provider',
    flag: STUB_FLAGS['equities-provider'],
    flagged: true,
    licensed: false,
    licensingNeed:
      'Exchange redistribution licences (real-time and delayed) per venue, display and non-display use, per-user fees',
    openQuestion: MD,
  },
  {
    id: 'md-americas-futures',
    kind: 'market_data',
    description: 'US futures and options on futures (energy, metals, agriculture, equity index)',
    continents: ['americas'],
    venues: ['XCME'],
    assetClasses: ['future', 'energy', 'metal', 'agri'],
    adapter: null,
    flag: 'KORA_MD_ADAPTER_FUTURES',
    flagged: true,
    licensed: false,
    licensingNeed: 'Derivatives exchange market-data licence and distributor agreement',
    openQuestion: MD,
  },
  {
    id: 'md-europe',
    kind: 'market_data',
    description: 'European equities, ETFs and index levels (London, Frankfurt, Paris)',
    continents: ['europe'],
    venues: ['XLON', 'XETR', 'XPAR'],
    assetClasses: ['equity', 'etf', 'index', 'bond'],
    adapter: null,
    flag: 'KORA_MD_ADAPTER_EUROPE',
    flagged: true,
    licensed: false,
    licensingNeed: 'Per-venue data licences, MiFID II delayed-data terms, index vendor licences',
    openQuestion: MD,
  },
  {
    id: 'md-africa',
    kind: 'market_data',
    description: 'Johannesburg equities and index levels',
    continents: ['africa'],
    venues: ['XJSE'],
    assetClasses: ['equity', 'index'],
    adapter: null,
    flag: 'KORA_MD_ADAPTER_AFRICA',
    flagged: true,
    licensed: false,
    licensingNeed: 'Exchange information-services licence (real-time and end-of-day)',
    openQuestion: MD,
  },
  {
    id: 'md-asia',
    kind: 'market_data',
    description: 'Tokyo, Hong Kong, Shanghai and India equities and index levels',
    continents: ['asia'],
    venues: ['XTKS', 'XHKG', 'XSHG', 'XNSE'],
    assetClasses: ['equity', 'index', 'etf'],
    adapter: null,
    flag: 'KORA_MD_ADAPTER_ASIA',
    flagged: true,
    licensed: false,
    licensingNeed:
      'Per-venue vendor licences; mainland China data needs a separately approved distributor',
    openQuestion: MD,
  },
  {
    id: 'md-oceania',
    kind: 'market_data',
    description: 'Australian and New Zealand equities',
    continents: ['oceania'],
    venues: ['XASX', 'XNZE'],
    assetClasses: ['equity', 'etf'],
    adapter: null,
    flag: 'KORA_MD_ADAPTER_OCEANIA',
    flagged: true,
    licensed: false,
    licensingNeed: 'Exchange market-information licence per venue',
    openQuestion: MD,
  },
  {
    id: 'md-global-otc',
    kind: 'market_data',
    description:
      'FX, spot metals, CFDs and crypto from a liquidity provider / broker (all continents)',
    continents: [...CONTINENTS],
    venues: ['KSIM', 'KCRY'],
    assetClasses: ['fx', 'metal', 'cfd', 'crypto', 'bond', 'fund'],
    adapter: 'broker-fxcfd',
    flag: STUB_FLAGS['broker-fxcfd'],
    flagged: true,
    licensed: false,
    licensingNeed:
      'Broker/liquidity-provider price-feed agreement (with OQ-B1), crypto venue API terms',
    openQuestion: MD,
  },
  {
    id: 'news-americas',
    kind: 'news',
    description: 'Newswire covering the Americas (company, macro and commodity news)',
    continents: ['americas'],
    venues: [],
    assetClasses: [...ASSET_CLASSES],
    adapter: 'news:newswire-americas',
    flag: 'KORA_NEWS_ADAPTER_AMERICAS',
    flagged: true,
    licensed: false,
    languages: ['en', 'es', 'pt', 'fr'],
    licensingNeed:
      'News redistribution licence including the right to process articles with an AI model',
    openQuestion: NEWS,
  },
  {
    id: 'news-emea',
    kind: 'news',
    description: 'Newswire covering Europe, the Middle East and Africa',
    continents: ['europe', 'africa'],
    venues: [],
    assetClasses: [...ASSET_CLASSES],
    adapter: 'news:newswire-emea',
    flag: 'KORA_NEWS_ADAPTER_EMEA',
    flagged: true,
    licensed: false,
    languages: ['en', 'de', 'fr', 'es', 'ar'],
    licensingNeed: 'News redistribution licence including AI processing and translation rights',
    openQuestion: NEWS,
  },
  {
    id: 'news-apac',
    kind: 'news',
    description: 'Newswire covering Asia and Oceania',
    continents: ['asia', 'oceania'],
    venues: [],
    assetClasses: [...ASSET_CLASSES],
    adapter: 'news:newswire-apac',
    flag: 'KORA_NEWS_ADAPTER_APAC',
    flagged: true,
    licensed: false,
    languages: ['en', 'ja', 'zh'],
    licensingNeed: 'News redistribution licence including AI processing and translation rights',
    openQuestion: NEWS,
  },
];
