import {
  ASSET_CLASSES,
  assertTimeZone,
  CalendarEventSchema,
  MIC_RE,
  REGIONS,
  sessionState,
  SYMBOL_RE,
  validateCalendar,
} from '@kora/domain';
import { describe, expect, it } from 'vitest';

import { Prng } from '../prng.js';
import { eventsToShocks, SimulatedCalendarProvider } from '../sim/calendar.js';
import { aliasMap, SEED_ALIASES } from './aliases.js';
import { SEED_ASSET_CLASSES, SEED_INSTRUMENTS } from './instruments.js';
import { simProfileFor } from './sim-profiles.js';
import { SEED_VENUES } from './venues.js';

/** ISO 6166 check digit (Luhn over the letter-expanded string). */
function isinValid(isin: string): boolean {
  if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin)) return false;
  const digits = isin
    .slice(0, 11)
    .split('')
    .map((c) => (/\d/.test(c) ? c : String(c.charCodeAt(0) - 55)))
    .join('');
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10 === Number(isin[11]);
}

describe('seed registry (SIMULATED)', () => {
  it('covers the prototype watchlist and every asset class', () => {
    const symbols = SEED_INSTRUMENTS.map((i) => i.symbol);
    for (const s of [
      'EURUSD',
      'GBPUSD',
      'USDJPY',
      'XAUUSD',
      'BTCUSD',
      'ETHUSD',
      'US500',
      'NAS100',
      'AAPL',
      'NVDA',
      'WTI',
    ])
      expect(symbols).toContain(s);
    expect(new Set(symbols).size).toBe(symbols.length);
    expect(symbols.length).toBeGreaterThanOrEqual(30);
    const classes = new Set(SEED_INSTRUMENTS.map((i) => i.assetClass));
    for (const c of ASSET_CLASSES) expect(classes.has(c)).toBe(true);
    expect(SEED_ASSET_CLASSES.map((a) => a.assetClass).sort()).toEqual([...ASSET_CLASSES].sort());
    expect(SEED_INSTRUMENTS.every((i) => i.simulated && SYMBOL_RE.test(i.symbol))).toBe(true);
  });

  it('venues span all five continents with valid MICs, timezones and calendars', () => {
    const regions = new Set(SEED_VENUES.map((v) => v.region));
    for (const r of REGIONS) expect(regions.has(r)).toBe(true);
    for (const v of SEED_VENUES) {
      expect(v.mic).toMatch(MIC_RE);
      expect(v.country).toMatch(/^[A-Z]{2}$/);
      expect(v.currency).toMatch(/^[A-Z]{3}$/);
      expect(() => assertTimeZone(v.timezone)).not.toThrow();
      expect(validateCalendar(v.calendar)).toEqual([]);
      expect(v.calendarSource).toMatch(/SIMULATED/);
    }
    const mics = new Set(SEED_VENUES.map((v) => v.mic));
    for (const i of SEED_INSTRUMENTS) {
      expect(mics.has(i.venue)).toBe(true);
      if (i.tradingSessions) {
        expect(validateCalendar(i.tradingSessions)).toEqual([]);
        expect(() => assertTimeZone(i.tradingSessions!.timezone)).not.toThrow();
      }
    }
    expect(SEED_VENUES.filter((v) => !v.isoMic).map((v) => v.mic)).toEqual(['KSIM', 'KCRY']);
  });

  it('seeded venue calendars behave across DST (XNYS, XLON, XTKS, XHKG, XJSE, BVMF, XASX)', () => {
    const v = (mic: string) => SEED_VENUES.find((x) => x.mic === mic)!;
    const st = (mic: string, iso: string) =>
      sessionState(v(mic).calendar, v(mic).timezone, Date.parse(iso));
    expect(st('XNYS', '2026-03-06T14:00:00Z')).toBe('closed');
    expect(st('XNYS', '2026-03-09T14:00:00Z')).toBe('open');
    expect(st('XNYS', '2026-04-03T15:00:00Z')).toBe('holiday');
    expect(st('XLON', '2026-03-30T07:30:00Z')).toBe('open');
    expect(st('XLON', '2026-03-27T07:30:00Z')).toBe('closed');
    expect(st('XTKS', '2026-03-10T03:00:00Z')).toBe('break');
    expect(st('XHKG', '2026-03-10T04:30:00Z')).toBe('break');
    expect(st('XJSE', '2026-07-14T07:30:00Z')).toBe('open');
    expect(st('BVMF', '2026-07-15T13:30:00Z')).toBe('open');
    expect(st('XASX', '2026-03-31T23:30:00Z')).toBe('open');
    expect(st('XASX', '2026-04-07T23:30:00Z')).toBe('closed');
    expect(st('XCME', '2026-09-24T21:30:00Z')).toBe('break'); // 16:30 CT maintenance break
    expect(st('KCRY', '2026-09-26T12:00:00Z')).toBe('open');
  });

  it('ISINs carry valid check digits', () => {
    const withIsin = SEED_INSTRUMENTS.filter((i) => i.isin);
    expect(withIsin.length).toBeGreaterThanOrEqual(10);
    for (const i of withIsin)
      expect({ symbol: i.symbol, ok: isinValid(i.isin!) }).toEqual({ symbol: i.symbol, ok: true });
    expect(isinValid('US0378331006')).toBe(false);
  });

  it('every instrument has a sim profile (defaults for unknown symbols) and aliases resolve', () => {
    for (const i of SEED_INSTRUMENTS) expect(Number(simProfileFor(i).refPrice)).toBeGreaterThan(0);
    expect(simProfileFor({ symbol: 'NEWFX', assetClass: 'fx', tickSize: '0.00001' }).refPrice).toBe(
      '1',
    );
    expect(
      simProfileFor({ symbol: 'NEWEQ', assetClass: 'equity', tickSize: '0.01' }).refPrice,
    ).toBe('100');
    const symbols = new Set(SEED_INSTRUMENTS.map((i) => i.symbol));
    expect(SEED_ALIASES.every((a) => symbols.has(a.symbol))).toBe(true);
    expect(aliasMap('broker-fxcfd').EUR_USD).toBe('EURUSD');
    expect(aliasMap('crypto-testnet').BTCUSDT).toBe('BTCUSD');
  });
});

describe('SimulatedCalendarProvider', () => {
  it('is deterministic, weekday-only, schema-valid and labelled simulated', async () => {
    const p = new SimulatedCalendarProvider(1);
    const from = Date.parse('2026-09-21T00:00:00Z'); // Monday
    const to = from + 7 * 86_400_000;
    const a = await p.getEvents(from, to);
    expect(a).toEqual(await new SimulatedCalendarProvider(1).getEvents(from, to));
    expect(a).not.toEqual(await new SimulatedCalendarProvider(2).getEvents(from, to));
    expect(a.length).toBeGreaterThanOrEqual(15);
    for (const e of a) {
      expect(CalendarEventSchema.parse(e)).toEqual(e);
      expect(e.source).toBe('simulated');
      expect([0, 6]).not.toContain(new Date(e.time).getUTCDay());
    }
    expect(a.every((e, i) => i === 0 || e.time >= a[i - 1]!.time)).toBe(true);
    expect(new Set(a.map((e) => e.id)).size).toBe(a.length);
    const mid = await p.getEvents(from + 12 * 3_600_000, from + 13 * 3_600_000);
    expect(mid.every((e) => Date.parse(e.time) >= from + 12 * 3_600_000)).toBe(true);
    expect(eventsToShocks(a.slice(0, 1))[0]).toMatchObject({
      id: a[0]!.id,
      ts: Date.parse(a[0]!.time),
      impact: a[0]!.impact,
    });
  });
});

describe('Prng', () => {
  it('is reproducible and roughly uniform / normal / poisson', () => {
    const a = new Prng('x');
    const b = new Prng('x');
    const xs = Array.from({ length: 5000 }, () => a.next());
    expect(xs).toEqual(Array.from({ length: 5000 }, () => b.next()));
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(mean).toBeGreaterThan(0.47);
    expect(mean).toBeLessThan(0.53);
    const n = new Prng(5);
    const zs = Array.from({ length: 5000 }, () => n.normal());
    const zm = zs.reduce((s, x) => s + x, 0) / zs.length;
    const zv = zs.reduce((s, x) => s + (x - zm) ** 2, 0) / zs.length;
    expect(Math.abs(zm)).toBeLessThan(0.06);
    expect(Math.abs(zv - 1)).toBeLessThan(0.08);
    const p = new Prng(9);
    const ps = Array.from({ length: 5000 }, () => p.poisson(0.3));
    expect(Math.abs(ps.reduce((s, x) => s + x, 0) / ps.length - 0.3)).toBeLessThan(0.03);
    expect(new Prng(0).int(10)).toBeLessThan(10);
  });
});
