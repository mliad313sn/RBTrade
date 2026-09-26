import { OPEN_ORDER_STATUSES, type FillDto, type OrderDto, type PositionDto } from '@kora/domain';
import type { AccountView } from '@kora/sdk';
import { create } from 'zustand';

import { api } from '@/lib/api-browser';

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
  fills: FillDto[];
  loaded: boolean;
  fillSeq: number;
  set: (p: Partial<TradingState>) => void;
}

export const useTrading = create<TradingState>((set) => ({
  accountId: null,
  currency: 'USD',
  account: null,
  orders: [],
  recent: [],
  positions: [],
  fills: [],
  loaded: false,
  fillSeq: 0,
  set: (p) => set(p),
}));

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
  if (pos.status === 'fulfilled') patch.positions = pos.value.positions;
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
      store.subscribe<{ positions: PositionDto[] }>(`positions:${accountId}`, (m) => useTrading.getState().set({ positions: m.positions })),
      store.subscribe<{ account: AccountView }>(`account:${accountId}`, (m) => useTrading.getState().set({ account: m.account })),
    ];
  };
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
