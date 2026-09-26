import { sessionState, sessionStatus } from '@kora/domain';
import { describe, expect, it } from 'vitest';

import { SEED_VENUES } from './venues.js';

/**
 * Goal 07B acceptance: session status is correct across DST **and holidays** on the seeded
 * (SIMULATED sample) calendars of XNYS, XLON, XTKS, XHKG, XJSE, BVMF and XASX.
 */
const venue = (mic: string) => SEED_VENUES.find((v) => v.mic === mic)!;
const st = (mic: string, iso: string) => sessionState(venue(mic).calendar, venue(mic).timezone, Date.parse(iso));
const status = (mic: string, iso: string) => sessionStatus(venue(mic).calendar, venue(mic).timezone, Date.parse(iso));

describe('seeded venue sessions: DST and holidays', () => {
  it('XNYS: DST switch, Good Friday and Thanksgiving holidays, the early close after Thanksgiving', () => {
    expect(st('XNYS', '2026-03-06T14:00:00Z')).toBe('closed'); // 09:00 EST
    expect(st('XNYS', '2026-03-09T14:00:00Z')).toBe('open'); // 10:00 EDT
    expect(st('XNYS', '2026-04-03T15:00:00Z')).toBe('holiday');
    expect(status('XNYS', '2026-11-26T16:00:00Z')).toMatchObject({ state: 'holiday', nextState: 'closed' });
    expect(st('XNYS', '2026-11-27T17:30:00Z')).toBe('open'); // 12:30 EST
    expect(st('XNYS', '2026-11-27T18:30:00Z')).toBe('closed'); // after the 13:00 early close
  });

  it('XLON: UK DST, Easter Monday and the Christmas Eve early close', () => {
    expect(st('XLON', '2026-03-27T07:30:00Z')).toBe('closed'); // 07:30 GMT
    expect(st('XLON', '2026-03-30T07:30:00Z')).toBe('open'); // 08:30 BST
    expect(st('XLON', '2026-04-06T10:00:00Z')).toBe('holiday');
    expect(st('XLON', '2026-12-24T12:00:00Z')).toBe('open');
    expect(st('XLON', '2026-12-24T13:00:00Z')).toBe('closed'); // 12:30 early close
  });

  it('XTKS: lunch break, no DST, the 2 January market holiday', () => {
    expect(st('XTKS', '2026-07-10T03:00:00Z')).toBe('break');
    expect(st('XTKS', '2026-01-02T01:00:00Z')).toBe('holiday');
    expect(st('XTKS', '2026-01-05T01:00:00Z')).toBe('open');
  });

  it('XHKG: lunch break and Christmas Day', () => {
    expect(st('XHKG', '2026-03-10T04:30:00Z')).toBe('break');
    expect(st('XHKG', '2026-12-25T02:00:00Z')).toBe('holiday');
    expect(st('XHKG', '2026-12-24T02:00:00Z')).toBe('open');
  });

  it('XJSE: UTC+2 all year and Freedom Day', () => {
    expect(st('XJSE', '2026-01-14T07:30:00Z')).toBe('open');
    expect(st('XJSE', '2026-07-14T07:30:00Z')).toBe('open');
    expect(st('XJSE', '2026-04-27T09:00:00Z')).toBe('holiday');
  });

  it('BVMF: no DST and Christmas (Natal)', () => {
    expect(st('BVMF', '2026-01-15T13:30:00Z')).toBe('open');
    expect(st('BVMF', '2026-07-15T12:30:00Z')).toBe('closed');
    expect(st('BVMF', '2026-12-25T15:00:00Z')).toBe('holiday');
  });

  it('XASX: southern-hemisphere DST and Australia Day', () => {
    expect(st('XASX', '2026-03-31T23:30:00Z')).toBe('open'); // 10:30 AEDT
    expect(st('XASX', '2026-04-07T23:30:00Z')).toBe('closed'); // 09:30 AEST
    expect(st('XASX', '2026-01-26T01:00:00Z')).toBe('holiday');
    expect(status('XASX', '2026-01-26T01:00:00Z').nextState).toBe('closed');
  });
});
