import { createHash } from 'node:crypto';

/**
 * News pipeline pieces (goal 07B §4), framework-free: normalisation, content hash and near-duplicate
 * detection, a local language guess, and dictionary entity linking to registry symbols and venue
 * MICs. Article text is untrusted: nothing here interprets it beyond matching.
 */

export interface NewsArticleInput {
  provider: string;
  externalId: string;
  sourceName: string;
  url: string;
  language: string | null;
  title: string;
  body: string;
  publishedAt: Date;
  simulated: boolean;
}

/** A news source. Real providers are flagged stubs until a licence is signed (OQ-M4). */
export interface NewsAdapter {
  readonly id: string;
  readonly regions: readonly string[];
  readonly languages: readonly string[];
  readonly flagged: boolean;
  readonly licensed: boolean;
  fetchSince(since: Date, now: Date): Promise<NewsArticleInput[]>;
}

const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}${String.fromCharCode(12)}${String.fromCharCode(14)}-${String.fromCharCode(31)}${String.fromCharCode(127)}${String.fromCharCode(0x200b)}-${String.fromCharCode(0x200f)}${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}]`,
  'g',
);

/** NFKC, invisible and control characters removed, whitespace collapsed. */
export function normaliseText(s: string): string {
  return s.normalize('NFKC').replace(CONTROL, '').replace(/\s+/g, ' ').trim();
}

export function contentHash(title: string, body: string): string {
  const t = `${normaliseText(title)}\n${normaliseText(body)}`.toLowerCase();
  return createHash('sha256').update(t).digest('hex');
}

/** Word 3-shingles for Latin text, character 4-shingles for CJK/Arabic scripts. */
export function shingles(text: string): Set<string> {
  const t = normaliseText(text).toLowerCase();
  const out = new Set<string>();
  if (/[぀-ヿ一-鿿؀-ۿ]/.test(t)) {
    const chars = [...t.replace(/\s+/g, '')];
    for (let i = 0; i + 4 <= chars.length; i++) out.add(chars.slice(i, i + 4).join(''));
    return out;
  }
  const words = t.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (let i = 0; i + 3 <= words.length; i++) out.add(words.slice(i, i + 3).join(' '));
  if (!out.size && words.length) out.add(words.join(' '));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

export const NEAR_DUPLICATE = 0.8;

export interface DedupCandidate {
  id: string;
  contentHash: string;
  text: string;
}

/** The earlier article this one duplicates (same hash, or shingle Jaccard ≥ 0.8), or null. */
export function findDuplicate(
  hash: string,
  text: string,
  earlier: readonly DedupCandidate[],
): { id: string; kind: 'exact' | 'near'; similarity: number } | null {
  // nosemgrep: ajinabraham.njsscan.crypto.timing_attack_node.node_timing_attack -- compares public content hashes, not secrets, reviewed goal 10
  const exact = earlier.find((e) => e.contentHash === hash);
  if (exact) return { id: exact.id, kind: 'exact', similarity: 1 };
  const sh = shingles(text);
  let best: { id: string; similarity: number } | null = null;
  for (const e of earlier) {
    const s = jaccard(sh, shingles(e.text));
    if (s >= NEAR_DUPLICATE && (!best || s > best.similarity)) best = { id: e.id, similarity: s };
  }
  return best ? { ...best, kind: 'near' } : null;
}

const STOPWORDS: Record<string, string[]> = {
  en: ['the', 'and', 'of', 'to', 'in', 'as', 'after', 'on', 'for', 'with', 'is', 'its'],
  fr: ['le', 'la', 'les', 'des', 'du', 'et', 'au', 'pour', 'une', 'est', 'par'],
  de: ['der', 'die', 'das', 'und', 'für', 'an', 'ist', 'mit', 'den', 'dem'],
  es: ['el', 'la', 'los', 'de', 'y', 'por', 'un', 'una', 'para', 'del', 'sube'],
  pt: ['o', 'a', 'os', 'de', 'e', 'no', 'na', 'do', 'da', 'para', 'um', 'uma'],
};

/** Local language guess (script, then stop-words). The gateway's translation confirms it. */
export function guessLanguage(text: string): string {
  if (/[぀-ヿ]/.test(text)) return 'ja';
  if (/[一-鿿]/.test(text)) return 'zh';
  if (/[؀-ۿ]/.test(text)) return 'ar';
  const words = normaliseText(text)
    .toLowerCase()
    .split(/[^\p{L}]+/u);
  let best = 'en';
  let score = -1;
  for (const [lang, list] of Object.entries(STOPWORDS)) {
    const s = words.filter((w) => list.includes(w)).length;
    if (s > score) {
      best = lang;
      score = s;
    }
  }
  return best;
}

export interface EntityTerm {
  term: string;
  kind: 'symbol' | 'venue';
  ref: string;
  /** Case-sensitive match (tickers such as SAP, BHP). */
  caseSensitive?: boolean;
}

/**
 * SIMULATED alias dictionary: company names, local-language names and venue names mapped to
 * registry symbols / MICs (a licensed reference-data feed would supply these, OQ-M2).
 */
export const ENTITY_ALIASES: EntityTerm[] = [
  { term: 'Toyota', kind: 'symbol', ref: '7203.XTKS' },
  { term: 'トヨタ', kind: 'symbol', ref: '7203.XTKS' },
  { term: 'Tencent', kind: 'symbol', ref: '0700.XHKG' },
  { term: '腾讯', kind: 'symbol', ref: '0700.XHKG' },
  { term: '騰訊', kind: 'symbol', ref: '0700.XHKG' },
  { term: 'Moutai', kind: 'symbol', ref: '600519.XSHG' },
  { term: '茅台', kind: 'symbol', ref: '600519.XSHG' },
  { term: 'Reliance Industries', kind: 'symbol', ref: 'RELIANCE.XNSE' },
  { term: 'Naspers', kind: 'symbol', ref: 'NPN.XJSE' },
  { term: 'Petrobras', kind: 'symbol', ref: 'PETR4.BVMF' },
  { term: 'BHP', kind: 'symbol', ref: 'BHP.XASX', caseSensitive: true },
  { term: 'Air New Zealand', kind: 'symbol', ref: 'AIR.XNZE' },
  { term: 'HSBC', kind: 'symbol', ref: 'HSBA.XLON', caseSensitive: true },
  { term: 'SAP', kind: 'symbol', ref: 'SAP.XETR', caseSensitive: true },
  { term: 'LVMH', kind: 'symbol', ref: 'MC.XPAR', caseSensitive: true },
  { term: 'Shopify', kind: 'symbol', ref: 'SHOP.XTSE' },
  { term: 'Apple', kind: 'symbol', ref: 'AAPL', caseSensitive: true },
  { term: 'Nvidia', kind: 'symbol', ref: 'NVDA' },
  { term: 'Microsoft', kind: 'symbol', ref: 'MSFT' },
  { term: 'Amazon', kind: 'symbol', ref: 'AMZN', caseSensitive: true },
  { term: 'Tesla', kind: 'symbol', ref: 'TSLA' },
  { term: 'Alphabet', kind: 'symbol', ref: 'GOOGL', caseSensitive: true },
  { term: 'gold', kind: 'symbol', ref: 'XAUUSD' },
  { term: 'oro', kind: 'symbol', ref: 'XAUUSD' },
  { term: 'Bitcoin', kind: 'symbol', ref: 'BTCUSD' },
  { term: 'oil prices', kind: 'symbol', ref: 'BRENT' },
  { term: 'أسعار النفط', kind: 'symbol', ref: 'BRENT' },
  { term: 'النفط', kind: 'symbol', ref: 'WTI' },
  { term: 'ECB', kind: 'symbol', ref: 'EURUSD', caseSensitive: true },
  { term: 'euro', kind: 'symbol', ref: 'EURUSD' },
  { term: 'Nikkei', kind: 'symbol', ref: 'JPN225' },
  { term: '日経平均', kind: 'symbol', ref: 'JPN225' },
  { term: '円安', kind: 'symbol', ref: 'USDJPY' },
  { term: 'Tokyo Stock Exchange', kind: 'venue', ref: 'XTKS' },
  { term: '東証', kind: 'venue', ref: 'XTKS' },
  { term: 'Hong Kong', kind: 'venue', ref: 'XHKG' },
  { term: '香港交易所', kind: 'venue', ref: 'XHKG' },
  { term: '上海证券交易所', kind: 'venue', ref: 'XSHG' },
  { term: 'Australian Securities Exchange', kind: 'venue', ref: 'XASX' },
  { term: 'London Stock Exchange', kind: 'venue', ref: 'XLON' },
  { term: 'Johannesburg Stock Exchange', kind: 'venue', ref: 'XJSE' },
  { term: 'Xetra', kind: 'venue', ref: 'XETR' },
  { term: 'B3', kind: 'venue', ref: 'BVMF', caseSensitive: true },
  { term: 'Toronto', kind: 'venue', ref: 'XTSE' },
];

const CJK = /[぀-ヿ一-鿿؀-ۿ]/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Dictionary entity linking; returns unique (kind, ref) with the first matching term. */
export function linkEntities(
  text: string,
  terms: readonly EntityTerm[],
): Array<{ kind: 'symbol' | 'venue'; ref: string; match: string }> {
  const t = normaliseText(text);
  const out = new Map<string, { kind: 'symbol' | 'venue'; ref: string; match: string }>();
  for (const term of terms) {
    const key = `${term.kind}:${term.ref}`;
    if (out.has(key)) continue;
    const body = escapeRe(term.term);
    const re = CJK.test(term.term)
      ? new RegExp(body)
      : new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, term.caseSensitive ? 'u' : 'iu');
    const m = re.exec(t);
    if (m) out.set(key, { kind: term.kind, ref: term.ref, match: m[0].slice(0, 120) });
  }
  return [...out.values()];
}
