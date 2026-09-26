'use client';

import '../terminal/terminal.css';

import { assetClassLabel, DEFAULT_HOTKEYS, type UpdatePreferences } from '@kora/domain';
import { Dialog, Kbd, useToast } from '@kora/ui';
import { Search } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { api } from '@/lib/api-browser';
import { hotkeyParts, isMacPlatform, matchHotkey } from '@/lib/terminal/hotkeys';
import { groupHits, REGION_LABEL, searchInstruments, useRegistry } from '@/lib/terminal/registry';
import { useTerminal } from '@/lib/terminal/store';

import { SessionBadge } from '../terminal/Badges';
import { useShell } from './ShellContext';

interface Action {
  id: string;
  label: string;
  keywords: string;
  run: () => void;
  terminalOnly?: boolean;
}

type Item = { kind: 'instrument'; symbol: string; id: string } | { kind: 'action'; action: Action; id: string };

/**
 * ⌘K command palette (B-009): search the whole instrument registry (every venue and asset class,
 * grouped by region then asset class, with the venue MIC and session) and run actions (screens,
 * layouts, display settings, alerts, hotkeys). Enter opens; Alt+Enter adds to the current watchlist.
 */
export function CommandPalette() {
  const { me, setMe } = useShell();
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'go' | 'add'>('go');
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const { instruments, venues, loaded, load } = useRegistry();
  const setSymbol = useTerminal((s) => s.setSymbol);
  const symbol = useTerminal((s) => s.symbol);
  const setCheatSheet = useTerminal((s) => s.setCheatSheet);
  const onTerminal = pathname.startsWith('/terminal');
  const spec = me.preferences.hotkeys.commandPalette ?? DEFAULT_HOTKEYS.commandPalette!;
  const mac = typeof navigator !== 'undefined' && isMacPlatform();

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (matchHotkey(e, spec, isMacPlatform()) || (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey)) {
        e.preventDefault();
        setMode('go');
        setOpen(true);
      }
    };
    const onEvent = (e: Event) => {
      setMode((e as CustomEvent<{ mode?: 'go' | 'add' }>).detail?.mode ?? 'go');
      setOpen(true);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('kora:palette', onEvent);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('kora:palette', onEvent);
    };
  }, [spec]);

  useEffect(() => {
    if (open) {
      void load();
      setQ('');
      setActive(0);
    }
  }, [open, load]);

  const savePrefs = async (patch: UpdatePreferences, msg: string) => {
    try {
      const r = await api.updatePreferences(patch);
      setMe({ ...me, preferences: r.preferences, capabilities: r.capabilities });
      toast.push(msg, 'success', 2500);
    } catch {
      toast.push('Could not save the setting', 'critical');
    }
  };

  const actions: Action[] = useMemo(
    () => [
      { id: 'go-terminal', label: 'Go to Terminal', keywords: 'terminal trade pro', run: () => router.push('/terminal') },
      { id: 'go-simulator', label: 'Go to Gain simulator', keywords: 'simulator monte carlo projection', run: () => router.push('/simulator') },
      { id: 'go-robots', label: 'Go to Robots', keywords: 'robots bots strategy', run: () => router.push('/robots') },
      { id: 'go-portfolio', label: 'Go to Portfolio', keywords: 'portfolio', run: () => router.push('/portfolio') },
      { id: 'go-audit', label: 'Open audit log', keywords: 'audit log history', run: () => router.push('/audit') },
      { id: 'go-settings', label: 'Open settings', keywords: 'settings preferences hotkeys', run: () => router.push('/settings') },
      { id: 'layout-save', label: 'Save or load a layout…', keywords: 'layout save load workspace', run: () => window.dispatchEvent(new CustomEvent('kora:layout', { detail: { action: 'open' } })), terminalOnly: true },
      { id: 'layout-reset', label: 'Reset layout to default', keywords: 'layout reset default', run: () => window.dispatchEvent(new CustomEvent('kora:layout', { detail: { action: 'reset' } })), terminalOnly: true },
      { id: 'alert', label: `New price alert on ${symbol}`, keywords: 'alert price rsi notify', run: () => window.dispatchEvent(new CustomEvent('kora:focus-panel', { detail: { id: 'alerts' } })), terminalOnly: true },
      { id: 'hotkeys', label: 'Show keyboard shortcuts', keywords: 'hotkeys shortcuts keyboard help', run: () => setCheatSheet(true), terminalOnly: true },
      { id: 'colours-bo', label: 'Colours: blue up / orange down', keywords: 'colour color blind', run: () => void savePrefs({ colourConvention: 'blue_orange' }, 'Colours: blue / orange') },
      { id: 'colours-gr', label: 'Colours: green up / red down', keywords: 'colour color green red', run: () => void savePrefs({ colourConvention: 'green_red' }, 'Colours: green / red') },
      { id: 'colours-asia', label: 'Colours: red up / green down (Asia)', keywords: 'colour color asia red', run: () => void savePrefs({ colourConvention: 'red_up_asia' }, 'Colours: red up (Asia)') },
      { id: 'density', label: `Density: ${me.preferences.terminal?.density === 'comfortable' ? 'compact' : 'comfortable'}`, keywords: 'density compact comfortable rows', run: () => void savePrefs({ terminal: { density: me.preferences.terminal?.density === 'comfortable' ? 'compact' : 'comfortable' } }, 'Density updated') },
      { id: 'time', label: `Show times in ${me.preferences.terminal?.timeDisplay === 'local' ? 'UTC' : 'local time'}`, keywords: 'time utc local clock', run: () => void savePrefs({ terminal: { timeDisplay: me.preferences.terminal?.timeDisplay === 'local' ? 'utc' : 'local' } }, 'Time display updated') },
      { id: 'kill', label: 'Kill switch (focus it, then hold 1.5 s)', keywords: 'kill switch halt stop flatten', run: () => document.querySelector<HTMLElement>('[data-testid="kill-switch"]')?.focus() },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [router, symbol, me.preferences.terminal, setCheatSheet],
  );

  const hits = useMemo(() => (loaded ? searchInstruments(q, instruments.values(), venues, q ? 40 : 30) : []), [q, instruments, venues, loaded]);
  const groups = useMemo(() => groupHits(hits), [hits]);
  const shownActions = useMemo(() => {
    if (mode === 'add') return [];
    const t = q.trim().toLowerCase();
    return actions.filter((a) => (!a.terminalOnly || onTerminal) && (!t || a.label.toLowerCase().includes(t) || a.keywords.includes(t)));
  }, [actions, q, mode, onTerminal]);

  const items: Item[] = useMemo(
    () => [
      ...groups.flatMap((g) => g.hits.map((h): Item => ({ kind: 'instrument', symbol: h.instrument.symbol, id: `pi-${h.instrument.symbol}` }))),
      ...shownActions.map((a): Item => ({ kind: 'action', action: a, id: `pa-${a.id}` })),
    ],
    [groups, shownActions],
  );
  const current = items[Math.min(active, items.length - 1)];

  const openInstrument = (s: string) => {
    setOpen(false);
    if (onTerminal) setSymbol(s);
    else router.push(`/terminal?symbol=${encodeURIComponent(s)}`);
  };
  const addToWatchlist = (s: string) => {
    window.dispatchEvent(new CustomEvent('kora:watchlist-add', { detail: { symbol: s } }));
    toast.push(`${instruments.get(s)?.displayName ?? s} added to the watchlist`, 'success', 2500);
    if (!onTerminal) router.push(`/terminal?symbol=${encodeURIComponent(s)}`);
  };
  const runItem = (it: Item | undefined, alt = false) => {
    if (!it) return;
    if (it.kind === 'action') {
      setOpen(false);
      it.action.run();
    } else if (alt || mode === 'add') {
      addToWatchlist(it.symbol);
      if (mode === 'add') setOpen(false);
    } else openInstrument(it.symbol);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = items.length;
      if (!n) return;
      const next = (active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      setActive(next);
      document.getElementById(items[next]!.id)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runItem(current, e.altKey);
    }
  };

  let idx = -1;
  const option = (it: Item, content: React.ReactNode) => {
    idx += 1;
    const i = idx;
    return (
      <div
        key={it.id}
        id={it.id}
        role="option"
        aria-selected={current?.id === it.id}
        className={`pal-opt ${current?.id === it.id ? 'is-active' : ''}`}
        onMouseMove={() => setActive(i)}
        onClick={() => runItem(it)}
        data-testid={it.kind === 'instrument' ? `palette-${it.symbol}` : `palette-action-${it.action.id}`}
      >
        {content}
      </div>
    );
  };

  return (
    <>
      <button
        type="button"
        className="hidden md:flex items-center gap-2 h-7 px-3 w-60 rounded border border-border bg-panel text-muted text-sm text-left cursor-pointer"
        aria-label="Open command palette: symbols and actions"
        aria-keyshortcuts="Meta+K Control+K"
        data-testid="command-palette"
        onClick={() => {
          setMode('go');
          setOpen(true);
        }}
      >
        <Search size={14} aria-hidden="true" />
        <span className="flex-1">Symbol, action, screen…</span>
        <Kbd>{hotkeyParts(spec, mac).join('')}</Kbd>
      </button>
      <Dialog open={open} onOpenChange={setOpen} title={mode === 'add' ? 'Add to watchlist' : 'Symbol or action'} description="Type a symbol, name, ISIN or venue MIC. Enter opens; Alt+Enter adds to the watchlist; Esc closes." data-testid="palette">
        <input
          className="k-input w-full"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={current?.id}
          aria-label="Search symbols and actions"
          placeholder="EUR/USD, 7203, XLON, US0378331005…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKey}
          autoFocus
          data-testid="palette-input"
        />
        <div id="palette-list" ref={listRef} role="listbox" aria-label="Results" className="pal-list">
          {!loaded ? <p className="text-muted text-xs">Loading instruments…</p> : null}
          {groups.map((g) => (
            <div key={`${g.region}-${g.assetClass}`} role="group" aria-label={`${REGION_LABEL[g.region]} · ${assetClassLabel(g.assetClass)}`}>
              <div className="pal-group" aria-hidden="true">
                {REGION_LABEL[g.region]} · {assetClassLabel(g.assetClass)}
              </div>
              {g.hits.map((h) =>
                option(
                  { kind: 'instrument', symbol: h.instrument.symbol, id: `pi-${h.instrument.symbol}` },
                  <>
                    <span className="pal-sym">{h.instrument.displayName}</span>
                    <span className="pal-sub">
                      {h.instrument.symbol} · {h.instrument.quoteCcy}
                    </span>
                    <SessionBadge mic={h.instrument.venue} state={h.instrument.session?.state} className="ml-auto" />
                  </>,
                ),
              )}
            </div>
          ))}
          {shownActions.length ? (
            <div role="group" aria-label="Actions">
              <div className="pal-group" aria-hidden="true">
                Actions
              </div>
              {shownActions.map((a) => option({ kind: 'action', action: a, id: `pa-${a.id}` }, <span>{a.label}</span>))}
            </div>
          ) : null}
          {loaded && items.length === 0 ? <p className="text-muted text-xs">No match.</p> : null}
        </div>
      </Dialog>
    </>
  );
}
