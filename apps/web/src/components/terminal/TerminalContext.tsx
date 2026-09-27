'use client';

import { DEFAULT_HOTKEYS, DEFAULT_TERMINAL_SETTINGS, type TerminalSettings } from '@kora/domain';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { useShell } from '@/components/shell/ShellContext';
import { MarketStore, percentile } from '@/lib/terminal/market-store';
import { useRegistry } from '@/lib/terminal/registry';
import { useFeedState } from '@/lib/terminal/store';
import { startTradingStream } from '@/lib/terminal/trading';

const Ctx = createContext<MarketStore | null>(null);

/** One market store (socket) per mounted terminal; starts the private trading stream. */
export function TerminalProvider({ wsPort, children }: { wsPort: string; children: ReactNode }) {
  const [store] = useState(() => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return new MarketStore({ url: `${proto}://${window.location.hostname}:${wsPort}/ws` });
  });
  const load = useRegistry((s) => s.load);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(true), 60_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    const stop = startTradingStream(store);
    const setFeed = useFeedState.getState().set;
    const offStatus = store.onStatus((s) => setFeed({ feed: s.state }));
    const offState = store.onState((s) => setFeed({ socket: s }));
    const perf = setInterval(
      () => setFeed({ tickP95: percentile(store.perf.ticks.slice(-200), 0.95) }),
      2000,
    );
    return () => {
      stop();
      offStatus();
      offState();
      clearInterval(perf);
      store.close();
      setFeed({ feed: null, socket: 'idle', tickP95: null });
    };
  }, [store]);

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useMarket(): MarketStore {
  const s = useContext(Ctx);
  if (!s) throw new Error('useMarket outside TerminalProvider');
  return s;
}

/** Terminal settings from the user's preferences (defaults when missing). */
export function useTerminalSettings(): TerminalSettings {
  const { me } = useShell();
  return { ...DEFAULT_TERMINAL_SETTINGS, ...(me.preferences.terminal ?? {}) };
}

export function useHotkeys(): Record<string, string> {
  const { me } = useShell();
  return { ...DEFAULT_HOTKEYS, ...me.preferences.hotkeys };
}
