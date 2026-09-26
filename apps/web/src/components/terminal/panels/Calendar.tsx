'use client';

import type { CalendarEvent } from '@kora/domain';
import { useEffect, useState } from 'react';

import { api } from '@/lib/api-browser';
import { clockLabel, formatClock } from '@/lib/terminal/format';

import { useTerminalSettings } from '../TerminalContext';

const IMPACT = { 1: 'Low impact', 2: 'Medium impact', 3: 'High impact' } as const;

/** Upcoming SIMULATED economic events (GET /calendar); impact shown as ●●● plus text for screen readers. */
export function CalendarPanel({ onTitle }: { onTitle?: (t: string) => void }) {
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [simulated, setSimulated] = useState(true);
  const { timeDisplay } = useTerminalSettings();

  useEffect(() => {
    onTitle?.(`Economic calendar · ${clockLabel(timeDisplay)}`);
  }, [timeDisplay, onTitle]);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .calendar({ from: Date.now() - 60 * 60_000, to: Date.now() + 36 * 3600_000 })
        .then((r) => {
          if (cancelled) return;
          setSimulated(r.simulated);
          setEvents(r.events.filter((e) => Date.parse(e.time) >= Date.now() - 30 * 60_000).slice(0, 12));
        })
        .catch(() => !cancelled && setEvents([]));
    void load();
    const t = setInterval(load, 5 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="cal h-full overflow-auto" data-testid="calendar" data-panel-root="calendar" tabIndex={0} aria-label="Economic calendar">
      {events === null ? (
        <p className="text-muted text-xs m-0">Loading…</p>
      ) : events.length === 0 ? (
        <p className="text-muted text-xs m-0">No events in the next 36 h.</p>
      ) : (
        <ul className="m-0 p-0 list-none">
          {events.map((e) => (
            <li key={e.id} className="cal-row">
              <span className="k-num">{formatClock(e.time, timeDisplay).slice(0, 5)}</span>
              <span className={`cal-impact cal-impact--${e.impact}`} aria-label={IMPACT[e.impact]} role="img">
                {'●'.repeat(e.impact)}
                <span className="cal-impact-rest" aria-hidden="true">{'●'.repeat(3 - e.impact)}</span>
              </span>
              <span className="truncate" title={`${e.currency} · ${e.title}`}>
                <span className="text-muted">{e.currency}</span> {e.title}
              </span>
            </li>
          ))}
        </ul>
      )}
      {simulated ? <p className="cal-foot">SIMULATED calendar · not real events</p> : null}
    </div>
  );
}
