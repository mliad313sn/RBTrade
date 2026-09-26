'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { clockLabel, formatClock } from '@/lib/terminal/format';
import { useFeedState } from '@/lib/terminal/store';

import { useShell } from './ShellContext';

type Conn = { state: 'connecting' | 'connected' | 'degraded' | 'offline'; latencyMs: number | null };

function useApiHealth(): Conn {
  const [conn, setConn] = useState<Conn>({ state: 'connecting', latencyMs: null });
  useEffect(() => {
    let alive = true;
    const probe = async () => {
      const t0 = performance.now();
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        const latencyMs = Math.round(performance.now() - t0);
        if (alive) setConn({ state: res.ok ? 'connected' : 'degraded', latencyMs });
      } catch {
        if (alive) setConn({ state: 'offline', latencyMs: null });
      }
    };
    void probe();
    const id = setInterval(probe, 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return conn;
}

function useClock(mode: 'utc' | 'local'): string {
  const [now, setNow] = useState<string>('--:--:--');
  useEffect(() => {
    const tick = () => setNow(formatClock(Date.now(), mode));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [mode]);
  return now;
}

const DOT: Record<Conn['state'], string> = {
  connecting: 'text-muted',
  connected: 'text-up',
  degraded: 'text-warn',
  offline: 'text-kill',
};
const LABEL: Record<Conn['state'], string> = {
  connecting: 'Connecting',
  connected: 'Connected',
  degraded: 'Degraded',
  offline: 'Offline',
};

/**
 * Connection = API /health (REST, measured client-side); feed state and tick-to-paint come from the
 * Pro terminal's market store while it is open. Robots arrive in goal 06.
 */
export function StatusBar() {
  const conn = useApiHealth();
  const { me } = useShell();
  const mode = me.preferences.terminal?.timeDisplay ?? 'utc';
  const utc = useClock(mode);
  const feed = useFeedState();
  return (
    <footer className="flex items-center gap-5 px-3 h-[23px] border-t border-border bg-bg text-xs text-muted k-num" data-testid="status-bar">
      <span role="status" aria-live="polite" className="flex items-center gap-1">
        <span aria-hidden="true" className={DOT[conn.state]}>
          ●
        </span>
        <span className="text-text">{LABEL[conn.state]}</span>
      </span>
      <span className="inline-block min-w-[11ch]" data-testid="status-latency">Latency {conn.latencyMs === null ? '—' : `${conn.latencyMs} ms`}</span>
      <span className="hidden md:inline" data-testid="status-feed">
        Feed: simulated{feed.feed ? ` · ${feed.feed}` : ''}
        {feed.socket === 'reconnecting' ? ' · reconnecting' : ''}
      </span>
      <span className="hidden lg:inline-block min-w-[17ch]" data-testid="status-tick">{feed.tickP95 !== null ? `Tick→paint p95 ${Math.round(feed.tickP95)} ms` : ''}</span>
      <span className="hidden lg:inline">Robots: none</span>
      <span className="ml-auto" aria-label={`${clockLabel(mode)} time ${utc}`} data-testid="status-clock">
        {clockLabel(mode)} {utc}
      </span>
      <span>Env: PAPER</span>
      <Link href="/audit" className="text-text underline-offset-2 hover:underline">
        Audit log ↗
      </Link>
    </footer>
  );
}
