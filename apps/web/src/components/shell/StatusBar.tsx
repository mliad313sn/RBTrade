'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { robotsApi } from '@/lib/robots/client';
import { robotsStatusLabel } from '@/lib/robots/format';
import { clockLabel, formatClock } from '@/lib/terminal/format';
import { useFeedState } from '@/lib/terminal/store';

import { useShell } from './ShellContext';

type Conn = {
  state: 'connecting' | 'connected' | 'degraded' | 'offline';
  latencyMs: number | null;
};

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

/** IRTC R5-03: running / paused robot counts from the robots API (refreshed every 10 s). */
export const ROBOTS_POLL_MS = 10_000;

function useRobotsLabel(enabled: boolean): string | null {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () =>
      robotsApi
        .robots()
        .then((r) => alive && setLabel(robotsStatusLabel(r.robots)))
        .catch(() => alive && setLabel(robotsStatusLabel(null)));
    void load();
    const id = setInterval(load, ROBOTS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [enabled]);
  return enabled ? label : null;
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
  // IRTC R5-15: a status, not a price direction: independent of the colour convention.
  connected: 'text-ok',
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
 * Pro terminal's market store while it is open; robots = running / paused counts from the robots API.
 */
export function StatusBar() {
  const conn = useApiHealth();
  const { me } = useShell();
  const mode = me.preferences.terminal?.timeDisplay ?? 'utc';
  const utc = useClock(mode);
  const feed = useFeedState();
  const robots = useRobotsLabel(me.capabilities.robotBuilder);
  return (
    <footer
      className="flex flex-wrap items-center gap-x-5 px-3 min-h-[23px] border-t border-border bg-bg text-xs text-muted k-num"
      data-testid="status-bar"
    >
      <span role="status" aria-live="polite" className="flex items-center gap-1">
        <span aria-hidden="true" className={DOT[conn.state]}>
          ●
        </span>
        <span className="text-text">{LABEL[conn.state]}</span>
      </span>
      <span className="inline-block min-w-[11ch]" data-testid="status-latency">
        Latency {conn.latencyMs === null ? '—' : `${conn.latencyMs} ms`}
      </span>
      <span className="hidden md:inline" data-testid="status-feed">
        Feed: simulated{feed.feed ? ` · ${feed.feed}` : ''}
        {feed.socket === 'reconnecting' ? ' · reconnecting' : ''}
      </span>
      <span className="hidden lg:inline-block min-w-[17ch]" data-testid="status-tick">
        {feed.tickP95 !== null ? `Tick→paint p95 ${Math.round(feed.tickP95)} ms` : ''}
      </span>
      {robots ? (
        <Link
          href="/robots"
          className="hidden lg:inline text-muted underline-offset-2 hover:underline"
          data-testid="status-robots"
        >
          {robots}
        </Link>
      ) : null}
      <span
        className="ml-auto"
        aria-label={`${clockLabel(mode)} time ${utc}`}
        data-testid="status-clock"
      >
        {clockLabel(mode)} {utc}
      </span>
      <span>Env: PAPER</span>
      <Link href="/audit" className="text-text underline-offset-2 hover:underline">
        Audit log ↗
      </Link>
    </footer>
  );
}
