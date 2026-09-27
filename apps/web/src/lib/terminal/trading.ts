import { OPEN_ORDER_STATUSES, type FillDto, type OrderDto, type PositionDto } from '@kora/domain';
import type { AccountView } from '@kora/sdk';
import { create } from 'zustand';

import { api } from '@/lib/api-browser';

import type { LiveQuote } from './live-book';
import type { MarketStore } from './market-store';

/**
 * Streaming blotter data (goal 04, B-305): open orders, positions and the account arrive on the
 * private WebSocket channels (`orders:`, `positions:`, `account:`); REST reloads on start, after
 * actions and every 5 s while the socket is not open (fallback), plus a slow reconcile every 20 s.
 */

interface TradingState {
  accountId: string | null;
  currency: string;
  account: AccountView | null;
  orders: OrderDto[];
  /** Recent orders of any status (source column, fill markers). */
  recent: OrderDto[];
  positions: PositionDto[];
  /** Client time the positions were last received (REST or `positions:` push). */
  positionsAt: number | null;
  fills: FillDto[];
  loaded: boolean;
  fillSeq: number;
  /** True while a terminal streams trading data and quotes (live mark-to-market is only valid then). */
  streaming: boolean;
  set: (p: Partial<TradingState>) => void;
}

export const useTrading = create<TradingState>((set) => ({
  accountId: null,
  currency: 'USD',
  account: null,
  orders: [],
  recent: [],
  positions: [],
  positionsAt: null,
  fills: [],
  loaded: false,
  fillSeq: 0,
  streaming: false,
  set: (p) => set(p),
}));

/**
 * Latest quote per open-position symbol, from the terminal's market store (IRTC R5-02): the blotter,
 * its summary and the top bar all reprice from these. Commits are throttled (~4 per second).
 */
interface LiveQuotesState {
  quotes: ReadonlyMap<string, LiveQuote>;
  set: (quotes: ReadonlyMap<string, LiveQuote>) => void;
}

export const useLiveQuotes = create<LiveQuotesState>((set) => ({
  quotes: new Map(),
  set: (quotes) => set({ quotes }),
}));

export const LIVE_QUOTES_COMMIT_MS = 250;

const isOpen = (o: OrderDto) => (OPEN_ORDER_STATUSES as readonly string[]).includes(o.status);

/** Merge order events (per transaction) into the open-orders list. Exported for tests. */
export function mergeOrders(current: OrderDto[], changed: OrderDto[]): OrderDto[] {
  const byId = new Map(current.map((o) => [o.id, o]));
  for (const o of changed) {
    if (isOpen(o)) byId.set(o.id, o);
    else byId.delete(o.id);
  }
  return [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

export async function reloadTrading(): Promise<void> {
  const [acct, ords, recent, pos, fl] = await Promise.allSettled([
    api.account(),
    api.orders({ status: 'open', limit: 500 }),
    api.orders({ status: 'all', limit: 200 }),
    api.positions(),
    api.fills({ limit: 200 }),
  ]);
  const s = useTrading.getState();
  const patch: Partial<TradingState> = { loaded: true };
  if (acct.status === 'fulfilled') Object.assign(patch, { account: acct.value, accountId: acct.value.id, currency: acct.value.baseCurrency });
  if (ords.status === 'fulfilled') patch.orders = ords.value.orders;
  if (recent.status === 'fulfilled') patch.recent = recent.value.orders;
  if (pos.status === 'fulfilled') Object.assign(patch, { positions: pos.value.positions, positionsAt: Date.now() });
  if (fl.status === 'fulfilled') {
    patch.fills = fl.value.fills;
    if (s.loaded && fl.value.fills.length && fl.value.fills[0]?.id !== s.fills[0]?.id) patch.fillSeq = s.fillSeq + 1;
  }
  s.set(patch);
}

/** Starts streaming for the terminal; returns a stop function. */
export function startTradingStream(store: MarketStore): () => void {
  let stopped = false;
  let unsubs: Array<() => void> = [];
  const subscribeAll = (accountId: string) => {
    unsubs.forEach((u) => u());
    unsubs = [
      store.subscribe<{ orders: OrderDto[] }>(`orders:${accountId}`, (m, meta) => {
        if (meta.snapshot) return;
        const s = useTrading.getState();
        const filledNow = m.orders.some((o) => {
          const prev = s.orders.find((x) => x.id === o.id) ?? s.recent.find((x) => x.id === o.id);
          return o.filledQty !== (prev?.filledQty ?? '0') && o.filledQty !== '0';
        });
        s.set({
          orders: mergeOrders(s.orders, m.orders),
          recent: mergeRecent(s.recent, m.orders),
          ...(filledNow ? { fillSeq: s.fillSeq + 1 } : {}),
        });
        if (filledNow) void api.fills({ limit: 200 }).then((f) => useTrading.getState().set({ fills: f.fills })).catch(() => undefined);
      }),
      store.subscribe<{ positions: PositionDto[] }>(`positions:${accountId}`, (m) => useTrading.getState().set({ positions: m.positions, positionsAt: Date.now() })),
      store.subscribe<{ account: AccountView }>(`account:${accountId}`, (m) => useTrading.getState().set({ account: m.account })),
    ];
  };
  // Live quotes for every open position (same market store as the watchlist and the ticket).
  const pending = new Map<string, LiveQuote>();
  const quoteUnsubs = new Map<string, () => void>();
  let commit: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    commit = null;
    const next = new Map(useLiveQuotes.getState().quotes);
    for (const [k, v] of pending) next.set(k, v);
    pending.clear();
    for (const k of next.keys()) if (!quoteUnsubs.has(k)) next.delete(k);
    useLiveQuotes.getState().set(next);
  };
  const syncQuotes = (positions: PositionDto[]) => {
    const want = new Set(positions.map((p) => p.symbol));
    for (const [sym, off] of quoteUnsubs) {
      if (!want.has(sym)) {
        off();
        quoteUnsubs.delete(sym);
      }
    }
    for (const sym of want) {
      if (quoteUnsubs.has(sym)) continue;
      quoteUnsubs.set(
        sym,
        store.onQuote(sym, (q) => {
          pending.set(sym, { bid: q.bid, ask: q.ask, stale: !!q.stale, receivedAt: Date.now() });
          commit ??= setTimeout(flush, LIVE_QUOTES_COMMIT_MS);
        }),
      );
    }
  };
  const offPositions = useTrading.subscribe((s, prev) => {
    if (s.positions !== prev.positions) syncQuotes(s.positions);
  });
  useTrading.getState().set({ streaming: true });
  syncQuotes(useTrading.getState().positions);
  void reloadTrading().then(() => {
    const id = useTrading.getState().accountId;
    if (!stopped && id) subscribeAll(id);
  });
  const fallback = setInterval(() => {
    if (store.state !== 'open') void reloadTrading();
  }, 5000);
  const reconcile = setInterval(() => void reloadTrading(), 20_000);
  const onRefresh = () => void reloadTrading();
  window.addEventListener('kora:blotter-refresh', onRefresh);
  return () => {
    stopped = true;
    clearInterval(fallback);
    clearInterval(reconcile);
    window.removeEventListener('kora:blotter-refresh', onRefresh);
    unsubs.forEach((u) => u());
    offPositions();
    quoteUnsubs.forEach((u) => u());
    quoteUnsubs.clear();
    if (commit) clearTimeout(commit);
    useLiveQuotes.getState().set(new Map());
    useTrading.getState().set({ streaming: false });
  };
}

function mergeRecent(current: OrderDto[], changed: OrderDto[]): OrderDto[] {
  const byId = new Map(current.map((o) => [o.id, o]));
  for (const o of changed) byId.set(o.id, o);
  return [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 300);
}

/** Refresh blotter + account after a user action (optimistic paths stay server-driven). */
export function refreshTrading(): void {
  window.dispatchEvent(new Event('kora:blotter-refresh'));
  window.dispatchEvent(new Event('kora:account-refresh'));
}
