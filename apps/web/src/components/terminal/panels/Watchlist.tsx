'use client';

import {
  assetClassLabel,
  dec,
  quoteBadge,
  sessionBadge,
  type Quote,
  type WatchlistDto,
} from '@kora/domain';
import type { InstrumentDto } from '@kora/sdk';
import { useToast } from '@kora/ui';
import { Plus, Trash2 } from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from 'react';

import { api } from '@/lib/api-browser';
import { useRegistry } from '@/lib/terminal/registry';
import { useTerminal } from '@/lib/terminal/store';
import { watchRowView } from '@/lib/terminal/views';

import { useMarket, useTerminalSettings } from '../TerminalContext';
import { VirtualRows, type VirtualRowsHandle } from '../VirtualRows';

const ACTIVE_KEY = 'kora.terminal.watchlist';
const FLASH_MS = 150;

/** Day opens for change %, fetched in batches (≤ 200 per request) for the rows on screen. */
const dayOpens = new Map<string, string | null>();
const dayOpenWaiters = new Map<string, Set<() => void>>();
let dayOpenQueue = new Set<string>();
let dayOpenTimer: ReturnType<typeof setTimeout> | null = null;
function requestDayOpen(symbol: string, cb: () => void): () => void {
  if (dayOpens.has(symbol)) {
    cb();
    return () => undefined;
  }
  const set = dayOpenWaiters.get(symbol) ?? new Set();
  set.add(cb);
  dayOpenWaiters.set(symbol, set);
  dayOpenQueue.add(symbol);
  dayOpenTimer ??= setTimeout(() => {
    const batch = [...dayOpenQueue].slice(0, 200);
    dayOpenQueue = new Set([...dayOpenQueue].slice(200));
    dayOpenTimer = null;
    void api
      .quotes(batch)
      .then((r) => {
        for (const q of r.quotes) {
          dayOpens.set(q.symbol, q.dayOpen);
          dayOpenWaiters.get(q.symbol)?.forEach((f) => f());
          dayOpenWaiters.delete(q.symbol);
        }
      })
      .catch(() => undefined);
  }, 50);
  return () => set.delete(cb);
}

const Row = memo(function Row({
  symbol,
  spec,
  active,
  focused,
  index,
  size,
  start,
  onSelect,
  onKey,
  onDragStart,
  onDrop,
  onRemove,
}: {
  symbol: string;
  spec: InstrumentDto | undefined;
  active: boolean;
  focused: boolean;
  index: number;
  size: number;
  start: number;
  onSelect: (s: string) => void;
  onKey: (e: KeyboardEvent<HTMLDivElement>, i: number) => void;
  onDragStart: (i: number) => void;
  onDrop: (i: number) => void;
  onRemove: (s: string) => void;
}) {
  const store = useMarket();
  const rowRef = useRef<HTMLDivElement>(null);
  const lastRef = useRef<HTMLSpanElement>(null);
  const chgRef = useRef<HTMLSpanElement>(null);
  const subRef = useRef<HTMLSpanElement>(null);
  const prevMid = useRef<string | null>(null);
  const session = spec?.session?.state ?? null;

  useEffect(() => {
    if (!spec) return;
    let quote: Quote | null = null;
    let flashTimer: ReturnType<typeof setTimeout> | null = null;
    const paint = () => {
      if (!quote || !rowRef.current) return;
      const v = watchRowView(quote, dayOpens.get(symbol), spec);
      const badge = quoteBadge({ stale: quote.stale, session });
      if (lastRef.current) lastRef.current.textContent = v.last;
      if (chgRef.current) {
        chgRef.current.textContent = v.change
          ? `${v.dir === 'up' ? '▲' : v.dir === 'down' ? '▼' : ''} ${v.change}`
          : '—';
        chgRef.current.className = `wl-chg k-dir--${v.dir}`;
      }
      if (subRef.current)
        subRef.current.textContent =
          badge === 'stale' ? 'Stale' : badge === 'closed' ? 'Closed' : `spr ${v.spread}`;
      rowRef.current.dataset.stale = badge === 'stale' ? 'true' : 'false';
      rowRef.current.dataset.closed = badge === 'closed' ? 'true' : 'false';
      const mid = v.mid;
      if (prevMid.current !== null && prevMid.current !== mid) {
        rowRef.current.dataset.flash = dec(mid).gt(dec(prevMid.current)) ? 'up' : 'down';
        if (flashTimer) clearTimeout(flashTimer);
        flashTimer = setTimeout(() => {
          if (rowRef.current) delete rowRef.current.dataset.flash;
        }, FLASH_MS);
      }
      prevMid.current = mid;
    };
    const offQ = store.onQuote(symbol, (q) => {
      quote = q;
      paint();
    });
    const offD = requestDayOpen(symbol, paint);
    return () => {
      offQ();
      offD();
      if (flashTimer) clearTimeout(flashTimer);
    };
  }, [store, symbol, spec, session]);

  const sb = sessionBadge(session);
  return (
    <div
      ref={rowRef}
      role="option"
      aria-selected={active}
      tabIndex={focused ? 0 : -1}
      data-testid={`wl-${symbol}`}
      data-index={index}
      data-stale="false"
      className="wl-row"
      style={{ height: size, transform: `translateY(${start}px)` }}
      onClick={() => onSelect(symbol)}
      onKeyDown={(e) => onKey(e, index)}
      draggable
      onDragStart={(e: DragEvent) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', symbol);
        onDragStart(index);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onDrop(index);
      }}
    >
      <span className="wl-sym">
        <span className="wl-name">{spec?.displayName ?? symbol}</span>
        <span className="wl-meta">
          {spec ? assetClassLabel(spec.assetClass, spec.underlyingClass) : '…'}
          {spec ? (
            <span className={`wl-sess k-session--${sb.tone}`} title={`${spec.venue}: ${sb.label}`}>
              {' '}
              · {spec.venue} <span aria-hidden="true">●</span>
              <span className="k-sr-only">{sb.label}</span>
            </span>
          ) : null}
        </span>
      </span>
      <span className="wl-num">
        <span ref={lastRef} className="wl-last k-num" data-testid={`wl-${symbol}-mid`}>
          —
        </span>
        <span ref={subRef} className="wl-sub k-num" data-testid={`wl-${symbol}-sub`} />
      </span>
      <span ref={chgRef} className="wl-chg k-dir--flat">
        —
      </span>
      <button
        type="button"
        className="wl-remove"
        aria-label={`Remove ${spec?.displayName ?? symbol} from the watchlist`}
        onClick={(e) => {
          e.stopPropagation();
          onRemove(symbol);
        }}
        tabIndex={-1}
      >
        <Trash2 size={11} aria-hidden="true" />
      </button>
    </div>
  );
});

/** Loads, persists and edits the user's watchlists (server-side, ≤ 500 symbols each). */
function useWatchlists() {
  const [lists, setLists] = useState<WatchlistDto[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    api
      .watchlists()
      .then((r) => {
        if (cancelled) return;
        setLists(r.watchlists);
        let saved: string | null = null;
        try {
          saved = window.localStorage.getItem(ACTIVE_KEY);
        } catch {
          /* ignore */
        }
        setActiveId(r.watchlists.find((w) => w.id === saved)?.id ?? r.watchlists[0]?.id ?? null);
      })
      .catch(() => toast.push('Watchlists unavailable', 'critical'));
    return () => {
      cancelled = true;
    };
  }, [toast]);

  const active = lists.find((l) => l.id === activeId) ?? null;
  const select = (id: string) => {
    setActiveId(id);
    try {
      window.localStorage.setItem(ACTIVE_KEY, id);
    } catch {
      /* ignore */
    }
  };
  const setSymbols = useCallback(
    (id: string, symbols: string[]) => {
      setLists((ls) => ls.map((l) => (l.id === id ? { ...l, symbols } : l)));
      api
        .updateWatchlist(id, { symbols })
        .catch((e: Error) => toast.push(`Could not save the watchlist: ${e.message}`, 'critical'));
    },
    [toast],
  );
  const create = async (name: string) => {
    const w = await api.createWatchlist(name, []);
    setLists((ls) => [...ls, w]);
    select(w.id);
  };
  const remove = async (id: string) => {
    await api.deleteWatchlist(id);
    setLists((ls) => ls.filter((l) => l.id !== id));
    setActiveId((cur) => (cur === id ? (lists.find((l) => l.id !== id)?.id ?? null) : cur));
  };
  return { lists, active, select, setSymbols, create, remove };
}

export function WatchlistPanel({ onTitle }: { onTitle?: (t: string) => void }) {
  const { lists, active, select, setSymbols, create, remove } = useWatchlists();
  const instruments = useRegistry((s) => s.instruments);
  const symbol = useTerminal((s) => s.symbol);
  const setSymbol = useTerminal((s) => s.setSymbol);
  const settings = useTerminalSettings();
  const listRef = useRef<VirtualRowsHandle>(null);
  const [focusIdx, setFocusIdx] = useState(0);
  const dragFrom = useRef<number | null>(null);
  const symbols = useMemo(() => active?.symbols ?? [], [active]);
  const rowH = settings.density === 'comfortable' ? 38 : 30;

  useEffect(() => {
    onTitle?.(`Watchlist · ${active?.name ?? '…'}`);
  }, [active?.name, onTitle]);

  // Add-to-watchlist requests from the ⌘K palette.
  useEffect(() => {
    const onAdd = (e: Event) => {
      const s = (e as CustomEvent<{ symbol: string }>).detail.symbol;
      if (!active || active.symbols.includes(s)) return;
      setSymbols(active.id, [...active.symbols, s]);
    };
    window.addEventListener('kora:watchlist-add', onAdd);
    return () => window.removeEventListener('kora:watchlist-add', onAdd);
  }, [active, setSymbols]);

  const move = (from: number, to: number) => {
    if (!active || from === to || to < 0 || to >= symbols.length) return;
    const next = [...symbols];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x!);
    setSymbols(active.id, next);
  };
  const removeSymbol = (s: string) =>
    active &&
    setSymbols(
      active.id,
      active.symbols.filter((x) => x !== s),
    );

  const onKey = (e: KeyboardEvent<HTMLDivElement>, i: number) => {
    const focusRow = (j: number) => {
      const k = Math.max(0, Math.min(symbols.length - 1, j));
      setFocusIdx(k);
      listRef.current?.scrollToIndex(k);
      requestAnimationFrame(() =>
        listRef.current?.element()?.querySelector<HTMLElement>(`[data-index="${k}"]`)?.focus(),
      );
    };
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const to = i + (e.key === 'ArrowUp' ? -1 : 1);
      move(i, to);
      focusRow(to);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      focusRow(i + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      focusRow(e.key === 'Home' ? 0 : symbols.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setSymbol(symbols[i]!);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      removeSymbol(symbols[i]!);
    }
  };

  const newList = () => {
    const name = window.prompt('Name of the new watchlist');
    if (name?.trim()) void create(name.trim());
  };

  return (
    <div
      className="flex flex-col h-full min-h-0"
      data-testid="watchlist"
      data-panel-root="watchlist"
      tabIndex={-1}
    >
      <div className="wl-toolbar">
        <label className="k-sr-only" htmlFor="wl-select">
          Watchlist
        </label>
        <select
          id="wl-select"
          className="wl-select"
          value={active?.id ?? ''}
          onChange={(e) => select(e.target.value)}
          data-testid="watchlist-select"
        >
          {lists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} ({l.symbols.length})
            </option>
          ))}
        </select>
        <button
          type="button"
          className="wl-tool"
          aria-label="Add a symbol (opens the command palette)"
          title="Add symbol (⌘K)"
          onClick={() =>
            window.dispatchEvent(new CustomEvent('kora:palette', { detail: { mode: 'add' } }))
          }
          data-testid="watchlist-add"
        >
          <Plus size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="wl-tool"
          onClick={newList}
          aria-label="New watchlist"
          title="New watchlist"
        >
          New
        </button>
        {active && lists.length > 1 ? (
          <button
            type="button"
            className="wl-tool"
            aria-label={`Delete watchlist ${active.name}`}
            title="Delete watchlist"
            onClick={() =>
              window.confirm(`Delete the watchlist "${active.name}"?`) && void remove(active.id)
            }
          >
            <Trash2 size={12} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <div className="wl-head" aria-hidden="true">
        <span>Symbol</span>
        <span className="text-right">Last</span>
        <span className="text-right">Chg</span>
      </div>
      <VirtualRows
        handleRef={listRef}
        items={symbols}
        rowHeight={rowH}
        getKey={(s) => s}
        className="wl-body"
        role="listbox"
        aria-label={`Watchlist ${active?.name ?? ''}: arrow keys move, Enter opens, Alt+arrow reorders, Delete removes`}
        data-testid="watchlist-rows"
        data-total={symbols.length}
        renderRow={(s, index, pos) => (
          <Row
            key={s}
            symbol={s}
            spec={instruments.get(s)}
            active={s === symbol}
            focused={index === focusIdx}
            index={index}
            size={pos.size}
            start={pos.start}
            onSelect={(x) => {
              setFocusIdx(index);
              setSymbol(x);
            }}
            onKey={onKey}
            onDragStart={(i) => (dragFrom.current = i)}
            onDrop={(i) => {
              if (dragFrom.current !== null) move(dragFrom.current, i);
              dragFrom.current = null;
            }}
            onRemove={removeSymbol}
          />
        )}
      />
      {active && symbols.length === 0 ? (
        <p className="text-muted text-xs px-2">Empty list. Press ⌘K to add symbols.</p>
      ) : null}
      <p className="wl-foot">Simulated feed · not market data</p>
    </div>
  );
}
