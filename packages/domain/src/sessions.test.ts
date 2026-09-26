import { describe, expect, it } from 'vitest';

import {
  assertTimeZone,
  parseHhmm,
  sessionState,
  sessionStatus,
  sessionsForDate,
  validateCalendar,
  zoneOffsetMs,
  type SessionCalendar,
} from './sessions.js';

const wk = (ranges: Array<[string, string]>): SessionCalendar['weekly'] => ({
  mon: ranges,
  tue: ranges,
  wed: ranges,
  thu: ranges,
  fri: ranges,
});

const XNYS: SessionCalendar = {
  weekly: wk([['09:30', '16:00']]),
  holidays: [{ date: '2026-12-25', name: 'Christmas Day' }],
  earlyCloses: [{ date: '2026-11-27', close: '13:00', name: 'Day after Thanksgiving' }],
};
const XLON: SessionCalendar = { weekly: wk([['08:00', '16:30']]) };
const XTKS: SessionCalendar = { weekly: wk([['09:00', '11:30'], ['12:30', '15:30']]) };
const XHKG: SessionCalendar = { weekly: wk([['09:30', '12:00'], ['13:00', '16:00']]) };
const XJSE: SessionCalendar = { weekly: wk([['09:00', '17:00']]) };
const BVMF: SessionCalendar = { weekly: wk([['10:00', '17:00']]) };
const XASX: SessionCalendar = { weekly: wk([['10:00', '16:00']]) };
const FX24x5: SessionCalendar = {
  weekly: {
    sun: [['17:00', '24:00']],
    mon: [['00:00', '24:00']],
    tue: [['00:00', '24:00']],
    wed: [['00:00', '24:00']],
    thu: [['00:00', '24:00']],
    fri: [['00:00', '17:00']],
  },
};
const ALWAYS: SessionCalendar = {
  weekly: Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, [['00:00', '24:00']]])),
};

const at = (iso: string) => Date.parse(iso);

describe('sessions across DST', () => {
  it('XNYS opens at 14:30Z in EST and 13:30Z in EDT (US DST starts 2026-03-08)', () => {
    expect(sessionState(XNYS, 'America/New_York', at('2026-03-06T13:45:00Z'))).toBe('closed');
    expect(sessionState(XNYS, 'America/New_York', at('2026-03-06T14:45:00Z'))).toBe('open');
    expect(sessionState(XNYS, 'America/New_York', at('2026-03-09T13:45:00Z'))).toBe('open');
    const s = sessionStatus(XNYS, 'America/New_York', at('2026-03-09T13:00:00Z'));
    expect(s).toMatchObject({ state: 'closed', localTime: '09:00', nextChange: '2026-03-09T13:30:00.000Z', nextState: 'open' });
    // US DST ends 2026-11-01: back to 14:30Z.
    expect(sessionStatus(XNYS, 'America/New_York', at('2026-11-02T12:00:00Z')).nextChange).toBe('2026-11-02T14:30:00.000Z');
  });

  it('XLON follows UK DST (2026-03-29), independent of the US change', () => {
    expect(sessionState(XLON, 'Europe/London', at('2026-03-27T08:15:00Z'))).toBe('open');
    expect(sessionState(XLON, 'Europe/London', at('2026-03-30T07:15:00Z'))).toBe('open');
    expect(sessionState(XLON, 'Europe/London', at('2026-03-30T15:45:00Z'))).toBe('closed');
    expect(sessionState(XLON, 'Europe/London', at('2026-03-27T16:15:00Z'))).toBe('open');
  });

  it('XTKS has a lunch break and no DST', () => {
    const s = sessionStatus(XTKS, 'Asia/Tokyo', at('2026-03-10T03:00:00Z'));
    expect(s).toMatchObject({ state: 'break', localTime: '12:00', nextChange: '2026-03-10T03:30:00.000Z', nextState: 'open' });
    expect(sessionState(XTKS, 'Asia/Tokyo', at('2026-07-10T03:00:00Z'))).toBe('break');
    expect(sessionState(XTKS, 'Asia/Tokyo', at('2026-03-10T06:29:00Z'))).toBe('open');
    expect(sessionState(XTKS, 'Asia/Tokyo', at('2026-03-10T06:31:00Z'))).toBe('closed');
  });

  it('XHKG lunch break 12:00-13:00 HKT', () => {
    expect(sessionState(XHKG, 'Asia/Hong_Kong', at('2026-03-10T04:30:00Z'))).toBe('break');
    expect(sessionState(XHKG, 'Asia/Hong_Kong', at('2026-03-10T05:05:00Z'))).toBe('open');
  });

  it('XJSE is UTC+2 all year', () => {
    for (const d of ['2026-01-14', '2026-07-14']) {
      expect(sessionState(XJSE, 'Africa/Johannesburg', at(`${d}T06:30:00Z`))).toBe('closed');
      expect(sessionState(XJSE, 'Africa/Johannesburg', at(`${d}T07:30:00Z`))).toBe('open');
    }
  });

  it('BVMF stays UTC-3 in January and July (no DST since 2019)', () => {
    expect(sessionState(BVMF, 'America/Sao_Paulo', at('2026-01-15T13:30:00Z'))).toBe('open');
    expect(sessionState(BVMF, 'America/Sao_Paulo', at('2026-07-15T13:30:00Z'))).toBe('open');
    expect(sessionState(BVMF, 'America/Sao_Paulo', at('2026-07-15T12:30:00Z'))).toBe('closed');
  });

  it('XASX follows southern-hemisphere DST (AEDT ends 2026-04-05)', () => {
    expect(sessionState(XASX, 'Australia/Sydney', at('2026-03-31T23:30:00Z'))).toBe('open'); // 10:30 AEDT
    expect(sessionState(XASX, 'Australia/Sydney', at('2026-04-07T23:30:00Z'))).toBe('closed'); // 09:30 AEST
    expect(sessionState(XASX, 'Australia/Sydney', at('2026-04-08T00:30:00Z'))).toBe('open');
    expect(zoneOffsetMs(at('2026-01-10T00:00:00Z'), 'Australia/Sydney')).toBe(11 * 3600_000);
    expect(zoneOffsetMs(at('2026-06-10T00:00:00Z'), 'Australia/Sydney')).toBe(10 * 3600_000);
  });
});

describe('weekends, holidays, early closes, 24/x', () => {
  it('weekend is closed and the next change is Monday open', () => {
    const s = sessionStatus(XNYS, 'America/New_York', at('2026-09-26T15:00:00Z'));
    expect(s).toMatchObject({ state: 'closed', nextChange: '2026-09-28T13:30:00.000Z', nextState: 'open' });
  });

  it('holidays and early closes come from data', () => {
    expect(sessionStatus(XNYS, 'America/New_York', at('2026-12-25T16:00:00Z'))).toMatchObject({
      state: 'holiday',
      nextState: 'closed',
    });
    expect(sessionState(XNYS, 'America/New_York', at('2026-11-27T17:30:00Z'))).toBe('open'); // 12:30 EST
    expect(sessionState(XNYS, 'America/New_York', at('2026-11-27T18:30:00Z'))).toBe('closed'); // 13:30 EST
    expect(sessionsForDate(XNYS, '2026-11-27')).toEqual([[570, 780]]);
    expect(sessionsForDate(XNYS, '2026-12-25')).toBe('holiday');
  });

  it('FX 24x5 on the New York convention spans midnight without a false change', () => {
    const sat = sessionStatus(FX24x5, 'America/New_York', at('2026-09-26T12:00:00Z'));
    expect(sat).toMatchObject({ state: 'closed', nextChange: '2026-09-27T21:00:00.000Z', nextState: 'open' });
    const mon = sessionStatus(FX24x5, 'America/New_York', at('2026-09-28T12:00:00Z'));
    expect(mon).toMatchObject({ state: 'open', nextChange: '2026-10-02T21:00:00.000Z', nextState: 'closed' });
  });

  it('24/7 never changes', () => {
    expect(sessionStatus(ALWAYS, 'UTC', at('2026-09-26T12:00:00Z'))).toMatchObject({ state: 'open', nextChange: null, nextState: null });
  });
});

describe('validation', () => {
  it('parses HH:MM and rejects bad values', () => {
    expect(parseHhmm('24:00')).toBe(1440);
    expect(() => parseHhmm('25:00')).toThrow(RangeError);
    expect(() => assertTimeZone('Mars/Olympus')).toThrow(RangeError);
  });

  it('reports calendar problems', () => {
    expect(validateCalendar(XTKS)).toEqual([]);
    const bad = {
      weekly: { mon: [['10:00', '09:00'], ['08:00', '11:00']], xyz: [['aa', '10:00']] },
      holidays: [{ date: '2026/1/1', name: 'x' }],
      earlyCloses: [{ date: '2026-1-1', close: '1pm' }],
    } as unknown as SessionCalendar;
    expect(validateCalendar(bad)).toEqual([
      'mon: start 10:00 not before end 09:00',
      'mon: overlapping ranges',
      'unknown weekday xyz',
      'xyz: Invalid HH:MM: aa',
      'bad holiday date 2026/1/1',
      'bad early-close date 2026-1-1',
      'bad early-close time 1pm',
    ]);
  });
});
