'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

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

function useUtcClock(): string {
  const [now, setNow] = useState<string>('--:--:--');
  useEffect(() => {
    const tick = () => setNow(new Date().toISOString().slice(11, 19));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
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

/** Connection = API /health (REST, measured client-side). Feed and robots arrive in goals 02/06. */
export function StatusBar() {
  const conn = useApiHealth();
  const utc = useUtcClock();
  return (
    <footer className="flex items-center gap-5 px-3 h-7 border-t border-border bg-bg text-xs text-muted k-num" data-testid="status-bar">
      <span role="status" aria-live="polite" className="flex items-center gap-1">
        <span aria-hidden="true" className={DOT[conn.state]}>
          ●
        </span>
        <span className="text-text">{LABEL[conn.state]}</span>
      </span>
      <span>Latency {conn.latencyMs === null ? '—' : `${conn.latencyMs} ms`}</span>
      <span className="hidden md:inline">Feed: simulated · not started</span>
      <span className="hidden lg:inline">Robots: none</span>
      <span className="ml-auto" aria-label={`UTC time ${utc}`}>
        UTC {utc}
      </span>
      <span>Env: PAPER</span>
      <Link href="/audit" className="text-text underline-offset-2 hover:underline">
        Audit log ↗
      </Link>
    </footer>
  );
}
