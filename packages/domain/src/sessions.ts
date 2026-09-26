/**
 * Trading-session status from venue data (goal 02, global registry). Pure: an IANA timezone plus a
 * calendar (weekly local-time sessions with lunch breaks, holidays and early closes). DST is handled
 * by computing everything in venue-local wall time through Intl, so no timezone library is needed.
 */

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Local "HH:MM" start/end; end may be "24:00". Two ranges on one day = lunch break between them. */
export type SessionRange = [string, string];

export interface SessionCalendar {
  weekly: Partial<Record<Weekday, SessionRange[]>>;
  holidays?: Array<{ date: string; name: string }>;
  earlyCloses?: Array<{ date: string; close: string; name?: string }>;
}

export type SessionState = 'open' | 'break' | 'closed' | 'holiday';

export interface SessionStatus {
  state: SessionState;
  /** Venue-local date (YYYY-MM-DD) and time (HH:MM). */
  localDate: string;
  localTime: string;
  /** Next instant (ISO UTC) at which the state changes; null when it never does (24/7). */
  nextChange: string | null;
  nextState: SessionState | null;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$|^24:00$/;
const DAY_MS = 86_400_000;
const LOOKAHEAD_DAYS = 15;

export function parseHhmm(s: string): number {
  if (!HHMM.test(s)) throw new RangeError(`Invalid HH:MM: ${s}`);
  const [h, m] = s.split(':');
  return Number(h) * 60 + Number(m);
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Throws RangeError for an unknown IANA zone. */
export function assertTimeZone(tz: string): void {
  formatter(tz);
}

interface LocalParts {
  y: number;
  m: number;
  d: number;
  minutes: number;
  seconds: number;
}

function localParts(ts: number, tz: string): LocalParts {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(new Date(ts))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return { y: p.year!, m: p.month!, d: p.day!, minutes: p.hour! * 60 + p.minute!, seconds: p.second! };
}

/** Offset of the zone at an instant, in ms (local wall time − UTC). */
export function zoneOffsetMs(ts: number, tz: string): number {
  const l = localParts(ts, tz);
  const wall = Date.UTC(l.y, l.m - 1, l.d, 0, l.minutes, l.seconds);
  return wall - Math.floor(ts / 1000) * 1000;
}

/** Venue-local wall time (date at midnight UTC + minutes) → UTC instant. */
function localToUtc(dayUtcMidnight: number, minutes: number, tz: string): number {
  const guess = dayUtcMidnight + minutes * 60_000;
  const o1 = zoneOffsetMs(guess, tz);
  const t = guess - o1;
  const o2 = zoneOffsetMs(t, tz);
  return o2 === o1 ? t : guess - o2;
}

const isoDate = (dayMs: number): string => new Date(dayMs).toISOString().slice(0, 10);
const hhmm = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** Effective [start, end) minute ranges for a local date, after holidays and early closes. */
export function sessionsForDate(cal: SessionCalendar, date: string): Array<[number, number]> | 'holiday' {
  if (cal.holidays?.some((h) => h.date === date)) return 'holiday';
  const weekday = WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
  let ranges = (cal.weekly[weekday] ?? []).map(([a, b]) => [parseHhmm(a), parseHhmm(b)] as [number, number]);
  const early = cal.earlyCloses?.find((e) => e.date === date);
  if (early) {
    const close = parseHhmm(early.close);
    ranges = ranges.filter(([a]) => a < close).map(([a, b]) => [a, Math.min(b, close)] as [number, number]);
  }
  return ranges.sort((x, y) => x[0] - y[0]);
}

function stateAt(cal: SessionCalendar, date: string, minutes: number): SessionState {
  const ranges = sessionsForDate(cal, date);
  if (ranges === 'holiday') return 'holiday';
  if (ranges.some(([a, b]) => minutes >= a && minutes < b)) return 'open';
  const before = ranges.some(([, b]) => b <= minutes);
  const after = ranges.some(([a]) => a > minutes);
  return before && after ? 'break' : 'closed';
}

/** State of a venue calendar at an instant. */
export function sessionState(cal: SessionCalendar, tz: string, ts: number): SessionState {
  const l = localParts(ts, tz);
  return stateAt(cal, isoDate(Date.UTC(l.y, l.m - 1, l.d)), l.minutes);
}

export function sessionStatus(cal: SessionCalendar, tz: string, at: Date | number): SessionStatus {
  const ts = typeof at === 'number' ? at : at.getTime();
  const l = localParts(ts, tz);
  const today = Date.UTC(l.y, l.m - 1, l.d);
  const state = stateAt(cal, isoDate(today), l.minutes);

  // Candidate boundaries: every session edge and local midnight over the look-ahead window.
  const candidates: number[] = [];
  for (let i = 0; i <= LOOKAHEAD_DAYS; i++) {
    const day = today + i * DAY_MS;
    candidates.push(localToUtc(day, 0, tz));
    const ranges = sessionsForDate(cal, isoDate(day));
    if (ranges !== 'holiday') for (const [a, b] of ranges) candidates.push(localToUtc(day, a, tz), localToUtc(day, b, tz));
  }
  candidates.sort((a, b) => a - b);
  let nextChange: string | null = null;
  let nextState: SessionState | null = null;
  for (const c of candidates) {
    if (c <= ts) continue;
    const s = sessionState(cal, tz, c);
    if (s !== state) {
      nextChange = new Date(c).toISOString();
      nextState = s;
      break;
    }
  }
  return { state, localDate: isoDate(today), localTime: hhmm(l.minutes), nextChange, nextState };
}

/** Validates a calendar's shape and times; returns a list of problems (empty = valid). */
export function validateCalendar(cal: SessionCalendar): string[] {
  const problems: string[] = [];
  for (const [day, ranges] of Object.entries(cal.weekly)) {
    if (!(WEEKDAYS as readonly string[]).includes(day)) problems.push(`unknown weekday ${day}`);
    let prevEnd = -1;
    for (const r of ranges ?? []) {
      try {
        const a = parseHhmm(r[0]);
        const b = parseHhmm(r[1]);
        if (a >= b) problems.push(`${day}: start ${r[0]} not before end ${r[1]}`);
        if (a < prevEnd) problems.push(`${day}: overlapping ranges`);
        prevEnd = b;
      } catch (e) {
        problems.push(`${day}: ${(e as Error).message}`);
      }
    }
  }
  for (const h of cal.holidays ?? []) if (!/^\d{4}-\d{2}-\d{2}$/.test(h.date)) problems.push(`bad holiday date ${h.date}`);
  for (const e of cal.earlyCloses ?? []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) problems.push(`bad early-close date ${e.date}`);
    if (!HHMM.test(e.close)) problems.push(`bad early-close time ${e.close}`);
  }
  return problems;
}
