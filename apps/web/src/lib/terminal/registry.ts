import type { AssetClass, Region } from '@kora/domain';
import type { InstrumentDto, VenueDto } from '@kora/sdk';
import { create } from 'zustand';

import { api } from '@/lib/api-browser';

/**
 * The instrument registry for the browser (global coverage: every venue and asset class), with
 * session state refreshed every minute so badges say "Closed" rather than "Stale" (B-208).
 */

interface RegistryState {
  instruments: Map<string, InstrumentDto>;
  venues: Map<string, VenueDto>;
  loaded: boolean;
  error: string | null;
  load: (force?: boolean) => Promise<void>;
}

let inflight: Promise<void> | null = null;
let lastLoad = 0;
const REFRESH_MS = 60_000;

export const useRegistry = create<RegistryState>((set, get) => ({
  instruments: new Map(),
  venues: new Map(),
  loaded: false,
  error: null,
  load: async (force = false) => {
    if (!force && get().loaded && Date.now() - lastLoad < REFRESH_MS) return;
    inflight ??= (async () => {
      try {
        const [{ instruments }, { venues }] = await Promise.all([api.instruments(), api.venues()]);
        lastLoad = Date.now();
        set({ instruments: new Map(instruments.map((i) => [i.symbol, i])), venues: new Map(venues.map((v) => [v.mic, v])), loaded: true, error: null });
      } catch (e) {
        set({ error: (e as Error).message });
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  },
}));

export const REGION_LABEL: Record<Region, string> = {
  north_america: 'North America',
  south_america: 'South America',
  europe: 'Europe',
  africa: 'Africa',
  asia: 'Asia',
  oceania: 'Oceania',
  global: 'Global (24h / OTC)',
};
export const REGION_ORDER: Region[] = ['north_america', 'south_america', 'europe', 'africa', 'asia', 'oceania', 'global'];

export interface SearchHit {
  instrument: InstrumentDto;
  region: Region;
  score: number;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Registry search for the ⌘K palette: symbol, display name ("EUR/USD" = "eurusd"), ISIN or venue
 * MIC. Exact symbol/name matches first, then prefixes, then substrings. Exported for tests.
 */
export function searchInstruments(query: string, instruments: Iterable<InstrumentDto>, venues: Map<string, VenueDto>, limit = 50): SearchHit[] {
  const q = norm(query);
  const hits: SearchHit[] = [];
  for (const i of instruments) {
    const region = venues.get(i.venue)?.region ?? 'global';
    if (!q) {
      hits.push({ instrument: i, region, score: 0 });
      continue;
    }
    const fields = [norm(i.symbol), norm(i.displayName), norm(i.isin ?? ''), norm(i.venue), norm(i.venueSymbol ?? '')];
    let score = -1;
    if (fields[0] === q || fields[1] === q) score = 100;
    else if (fields[0]!.startsWith(q) || fields[1]!.startsWith(q)) score = 80;
    else if (fields[2] === q || fields[3] === q) score = 70;
    else if (fields.some((f) => f && f.includes(q))) score = 40;
    if (score >= 0) hits.push({ instrument: i, region, score });
  }
  hits.sort((a, b) => b.score - a.score || REGION_ORDER.indexOf(a.region) - REGION_ORDER.indexOf(b.region) || a.instrument.symbol.localeCompare(b.instrument.symbol));
  return hits.slice(0, limit);
}

/** Groups hits by region, then asset class, keeping the hit order inside each group. */
export function groupHits(hits: SearchHit[]): Array<{ region: Region; assetClass: AssetClass; hits: SearchHit[] }> {
  const groups = new Map<string, { region: Region; assetClass: AssetClass; hits: SearchHit[]; best: number; first: number }>();
  hits.forEach((h, idx) => {
    const key = `${h.region}|${h.instrument.assetClass}`;
    const g = groups.get(key);
    if (g) g.hits.push(h);
    else groups.set(key, { region: h.region, assetClass: h.instrument.assetClass, hits: [h], best: h.score, first: idx });
  });
  return [...groups.values()]
    .sort((a, b) => b.best - a.best || REGION_ORDER.indexOf(a.region) - REGION_ORDER.indexOf(b.region) || a.first - b.first)
    .map(({ region, assetClass, hits: h }) => ({ region, assetClass, hits: h }));
}
