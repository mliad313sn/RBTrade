'use client';

import 'dockview-react/dist/styles/dockview.css';
import './terminal.css';

import { useToast } from '@kora/ui';
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewHeaderActionsProps, type IDockviewPanelProps, type SerializedDockview } from 'dockview-react';
import { LayoutGrid } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api as client } from '@/lib/api-browser';
import type { AiStripMode } from '@/lib/terminal/ai-strip';
import { isTypingTarget, isMacPlatform, matchHotkey } from '@/lib/terminal/hotkeys';
import { buildDefaultLayout, clearLocalLayout, FOCUS_PANELS, isCompleteLayout, loadLocalLayout, LOCAL_ACTIVE_KEY, PANEL_IDS, PANEL_TITLES, saveLocalLayout, type PanelId } from '@/lib/terminal/layout';
import { useTerminal, type PanelTarget } from '@/lib/terminal/store';
import { useTrading } from '@/lib/terminal/trading';

import { BlotterSummary, AlertsPanel, FillsPanel, OrdersPanel, PositionsPanel, RiskPanel } from './panels/Blotter';
import { CalendarPanel } from './panels/Calendar';
import { ChartPanel } from './panels/Chart';
import { OrderBookPanel } from './panels/OrderBook';
import { TicketPanel } from './panels/Ticket';
import { TimeAndSalesPanel } from './panels/TimeAndSales';
import { WatchlistPanel } from './panels/Watchlist';
import { HotkeyCheatSheet } from './HotkeyCheatSheet';
import { TerminalProvider, useHotkeys, useTerminalSettings } from './TerminalContext';

const DOCK_THEME = { name: 'kora', className: 'dockview-theme-kora', gap: 8, colorScheme: 'dark' as const, dndOverlayMounting: 'absolute' as const, dndTabIndicator: 'line' as const };

/** Spread text for the order book tab bar (set by the panel). */
let setBookSpread: ((t: string) => void) | null = null;

function panelComponents(aiStrip: AiStripMode): Record<string, React.FunctionComponent<IDockviewPanelProps>> {
  return {
    watchlist: (p) => <WatchlistPanel onTitle={(t) => p.api.setTitle(t)} />,
    calendar: (p) => <CalendarPanel onTitle={(t) => p.api.setTitle(t)} />,
    chart: () => <ChartPanel aiStrip={aiStrip} />,
    orderbook: () => <OrderBookPanel onTitleRight={(t) => setBookSpread?.(t)} />,
    trades: () => <TimeAndSalesPanel />,
    ticket: () => <TicketPanel />,
    positions: () => <PositionsPanel />,
    orders: () => <OrdersPanel />,
    fills: () => <FillsPanel />,
    alerts: () => <AlertsPanel />,
    risk: () => <RiskPanel />,
  };
}

function BookSpread() {
  const [t, setT] = useState('');
  useEffect(() => {
    setBookSpread = setT;
    return () => {
      setBookSpread = null;
    };
  }, []);
  return (
    <span className="dv-right-text k-num" data-testid="book-spread">
      {t}
    </span>
  );
}

function LayoutMenu() {
  return (
    <button type="button" className="dv-action" onClick={() => window.dispatchEvent(new CustomEvent('kora:layout-menu'))} aria-label="Layouts: save, load or reset" title="Layouts" data-testid="layout-menu">
      <LayoutGrid size={13} aria-hidden="true" /> Layout
    </button>
  );
}

function RightActions(props: IDockviewHeaderActionsProps) {
  const ids = props.panels.map((p) => p.id);
  if (ids.includes('chart')) return <LayoutMenu />;
  if (ids.includes('orderbook') && props.activePanel?.id === 'orderbook') return <BookSpread />;
  if (ids.includes('positions')) return <BlotterSummary />;
  return null;
}

function LayoutDialog({ dock, onClose }: { dock: DockviewApi; onClose: () => void }) {
  const toast = useToast();
  const [saved, setSaved] = useState<Array<{ name: string; layout: Record<string, unknown> }>>([]);
  const [name, setName] = useState('');
  const load = useCallback(() => {
    client
      .layouts()
      .then((r) => setSaved(r.layouts))
      .catch(() => toast.push('Saved layouts unavailable', 'critical'));
  }, [toast]);
  useEffect(load, [load]);
  const save = async () => {
    const n = name.trim();
    if (!n) return;
    try {
      await client.saveLayout(n, dock.toJSON() as unknown as Record<string, unknown>);
      try {
        window.localStorage.setItem(LOCAL_ACTIVE_KEY, n);
      } catch {
        /* ignore */
      }
      toast.push(`Layout "${n}" saved`, 'success', 3000);
      setName('');
      load();
    } catch (e) {
      toast.push(`Not saved: ${(e as Error).message}`, 'critical');
    }
  };
  const apply = (l: { name: string; layout: Record<string, unknown> }) => {
    if (!isCompleteLayout(l.layout)) return toast.push('That layout is from an older version; reset and save it again.', 'critical');
    try {
      dock.fromJSON(l.layout as unknown as SerializedDockview);
      const now = dock.toJSON();
      if (isCompleteLayout(now)) saveLocalLayout(now);
      toast.push(`Layout "${l.name}" loaded`, 'success', 3000);
      onClose();
    } catch {
      toast.push('Could not load that layout', 'critical');
    }
  };
  return (
    <div className="lay-pop" role="dialog" aria-label="Layouts" data-testid="layout-dialog" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="flex items-center justify-between">
        <strong className="text-xs uppercase tracking-wider">Layouts</strong>
        <button type="button" className="bl-btn" onClick={onClose} aria-label="Close layouts">
          ✕
        </button>
      </div>
      <form
        className="flex gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="k-sr-only" htmlFor="lay-name">
          Layout name
        </label>
        <input id="lay-name" className="k-input flex-1" placeholder="Name, e.g. Scalping" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} data-testid="layout-name" autoFocus />
        <button type="submit" className="bl-btn" data-testid="layout-save">
          Save
        </button>
      </form>
      <ul className="m-0 p-0 list-none flex flex-col gap-1">
        {saved.map((l) => (
          <li key={l.name} className="flex items-center gap-1">
            <button type="button" className="bl-btn flex-1 text-left" onClick={() => apply(l)} data-testid={`layout-load-${l.name}`}>
              {l.name}
            </button>
            <button type="button" className="bl-btn" aria-label={`Delete layout ${l.name}`} onClick={() => void client.deleteLayout(l.name).then(load)}>
              ✕
            </button>
          </li>
        ))}
        {saved.length === 0 ? <li className="text-muted text-xs">No saved layouts yet.</li> : null}
      </ul>
      <button
        type="button"
        className="bl-btn"
        onClick={() => {
          clearLocalLayout();
          buildDefaultLayout(dock);
          onClose();
        }}
        data-testid="layout-reset"
      >
        Reset to default
      </button>
    </div>
  );
}

function Dock({ aiStrip }: { aiStrip: AiStripMode }) {
  const [dock, setDock] = useState<DockviewApi | null>(null);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const components = useMemo(() => panelComponents(aiStrip), [aiStrip]);
  const hotkeys = useHotkeys();
  const requestFocus = useTerminal((s) => s.requestFocus);
  const setCheatSheet = useTerminal((s) => s.setCheatSheet);
  const openOrders = useTrading((s) => s.orders.filter((o) => o.execType !== 'none' || o.type === 'oco').length);
  const positionsCount = useTrading((s) => s.positions.length);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disposed = useRef(false);
  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);
  const { density } = useTerminalSettings();

  const onReady = (e: DockviewReadyEvent) => {
    const local = loadLocalLayout();
    let restored = false;
    if (local) {
      try {
        e.api.fromJSON(local);
        restored = e.api.panels.length === PANEL_IDS.length;
      } catch {
        restored = false;
      }
    }
    if (!restored) buildDefaultLayout(e.api);
    e.api.onDidLayoutChange(() => {
      if (disposed.current) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        const json = e.api.toJSON();
        // Never persist a partial layout (e.g. while the terminal unmounts).
        if (!disposed.current && isCompleteLayout(json)) saveLocalLayout(json);
      }, 400);
    });
    setDock(e.api);
  };

  useEffect(() => {
    dock?.getPanel('orders')?.api.setTitle(`${PANEL_TITLES.orders} (${openOrders})`);
  }, [dock, openOrders]);
  useEffect(() => {
    dock?.getPanel('positions')?.api.setTitle(`${PANEL_TITLES.positions} (${positionsCount})`);
  }, [dock, positionsCount]);

  const focusPanel = useCallback(
    (target: PanelTarget, focusRoot = true) => {
      const id: PanelId = FOCUS_PANELS[target];
      const panel = dock?.getPanel(id);
      if (!panel) return;
      panel.api.setActive();
      if (!focusRoot) return;
      if (target === 'ticket') return requestFocus('ticket');
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-panel-root="${id}"]`)?.focus());
    },
    [dock, requestFocus],
  );

  useEffect(() => {
    const mac = isMacPlatform();
    const onKey = (e: KeyboardEvent) => {
      const dialogOpen = Boolean(document.querySelector('[role="dialog"],[role="alertdialog"]'));
      const typing = isTypingTarget(e.target);
      const is = (id: string) => hotkeys[id] && matchHotkey(e, hotkeys[id]!, mac);
      if (is('submitOrder') && !dialogOpen) {
        e.preventDefault();
        requestFocus('ticket-submit');
        return;
      }
      const focusMap: Array<[string, PanelTarget]> = [
        ['focusWatchlist', 'watchlist'],
        ['focusChart', 'chart'],
        ['focusOrderBook', 'orderbook'],
        ['focusTicket', 'ticket'],
        ['focusBlotter', 'blotter'],
      ];
      for (const [id, target] of focusMap) {
        if (is(id)) {
          e.preventDefault();
          focusPanel(target);
          return;
        }
      }
      if (typing || dialogOpen) return;
      if (is('ticketBuy') || is('ticketSell')) {
        e.preventDefault();
        focusPanel('ticket', false);
        requestFocus(is('ticketBuy') ? 'ticket-buy' : 'ticket-sell');
      } else if (is('cheatSheet')) {
        e.preventDefault();
        setCheatSheet(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hotkeys, focusPanel, requestFocus, setCheatSheet]);

  useEffect(() => {
    const open = () => setLayoutOpen(true);
    const onLayout = (e: Event) => {
      const action = (e as CustomEvent<{ action: string }>).detail?.action;
      if (action === 'reset' && dock) {
        clearLocalLayout();
        buildDefaultLayout(dock);
      } else if (action === 'open') setLayoutOpen(true);
    };
    const onFocusPanel = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      const panel = id ? dock?.getPanel(id) : undefined;
      if (!panel) return;
      panel.api.setActive();
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-panel-root="${id}"]`)?.focus());
    };
    window.addEventListener('kora:layout-menu', open);
    window.addEventListener('kora:layout', onLayout);
    window.addEventListener('kora:focus-panel', onFocusPanel);
    return () => {
      window.removeEventListener('kora:layout-menu', open);
      window.removeEventListener('kora:layout', onLayout);
      window.removeEventListener('kora:focus-panel', onFocusPanel);
    };
  }, [dock]);

  return (
    <div className="dockview-theme-dark k-dock h-full" data-testid="terminal-dock" data-density={density}>
      <DockviewReact components={components} onReady={onReady} theme={DOCK_THEME} rightHeaderActionsComponent={RightActions} disableFloatingGroups={false} />
      {layoutOpen && dock ? <LayoutDialog dock={dock} onClose={() => setLayoutOpen(false)} /> : null}
    </div>
  );
}

/** Keeps the active symbol in the URL (?symbol=) without a server round trip. */
function SymbolUrlSync({ initialSymbol }: { initialSymbol: string }) {
  const symbol = useTerminal((s) => s.symbol);
  const setSymbol = useTerminal((s) => s.setSymbol);
  const first = useRef(true);
  useEffect(() => {
    setSymbol(initialSymbol);
  }, [initialSymbol, setSymbol]);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const url = new URL(window.location.href);
    if (url.searchParams.get('symbol') === symbol) return;
    url.searchParams.set('symbol', symbol);
    url.searchParams.delete('switched');
    window.history.replaceState(window.history.state, '', url.toString());
    document.title = `${symbol} · Terminal · KORA`;
  }, [symbol]);
  return null;
}

export default function ProTerminal({ initialSymbol, wsPort, aiStrip }: { initialSymbol: string; wsPort: string; aiStrip: AiStripMode }) {
  return (
    <TerminalProvider wsPort={wsPort}>
      <SymbolUrlSync initialSymbol={initialSymbol} />
      <Dock aiStrip={aiStrip} />
      <HotkeyCheatSheet />
    </TerminalProvider>
  );
}
