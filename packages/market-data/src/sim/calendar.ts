import type { CalendarEvent } from '@kora/domain';

import { Prng } from '../prng.js';
import type { EventShock } from './simulated-market.js';

/**
 * Economic calendar (goal 02). `EconomicCalendarProvider` is the seam for a real provider (flagged,
 * not implemented: needs a licensed feed, OQ-B2). The simulated provider generates a deterministic,
 * clearly SIMULATED schedule per UTC day from a seed: event titles are generic release types and
 * the times are invented, not a real release calendar.
 */
export interface EconomicCalendarProvider {
  readonly source: string;
  getEvents(from: number, to: number): Promise<CalendarEvent[]>;
}

interface Template {
  country: string;
  currency: string;
  title: string;
  impact: 1 | 2 | 3;
}

const TEMPLATES: Template[] = [
  { country: 'US', currency: 'USD', title: 'US CPI (m/m)', impact: 3 },
  { country: 'US', currency: 'USD', title: 'US Non-Farm Payrolls', impact: 3 },
  { country: 'US', currency: 'USD', title: 'FOMC minutes', impact: 2 },
  { country: 'US', currency: 'USD', title: 'US initial jobless claims', impact: 1 },
  { country: 'US', currency: 'USD', title: 'US crude oil inventories', impact: 2 },
  { country: 'EU', currency: 'EUR', title: 'ECB speaker', impact: 2 },
  { country: 'EU', currency: 'EUR', title: 'Euro-area PMI', impact: 2 },
  { country: 'DE', currency: 'EUR', title: 'Germany Ifo business climate', impact: 1 },
  { country: 'GB', currency: 'GBP', title: 'UK GDP (q/q)', impact: 2 },
  { country: 'GB', currency: 'GBP', title: 'BoE rate decision', impact: 3 },
  { country: 'JP', currency: 'JPY', title: 'Japan Tankan survey', impact: 2 },
  { country: 'JP', currency: 'JPY', title: 'BoJ speaker', impact: 1 },
  { country: 'CN', currency: 'CNY', title: 'China manufacturing PMI', impact: 2 },
  { country: 'AU', currency: 'AUD', title: 'Australia employment change', impact: 2 },
  { country: 'NZ', currency: 'NZD', title: 'New Zealand GDP (q/q)', impact: 2 },
  { country: 'CA', currency: 'CAD', title: 'Canada CPI (m/m)', impact: 2 },
  { country: 'CH', currency: 'CHF', title: 'Swiss KOF indicator', impact: 1 },
  { country: 'ZA', currency: 'ZAR', title: 'South Africa CPI (y/y)', impact: 2 },
  { country: 'BR', currency: 'BRL', title: 'Brazil Selic rate decision', impact: 3 },
  { country: 'IN', currency: 'INR', title: 'India RBI policy decision', impact: 3 },
];

const DAY_MS = 86_400_000;

export class SimulatedCalendarProvider implements EconomicCalendarProvider {
  readonly source = 'simulated';

  constructor(private readonly seed: string | number) {}

  async getEvents(from: number, to: number): Promise<CalendarEvent[]> {
    return this.eventsBetween(from, to);
  }

  eventsBetween(from: number, to: number): CalendarEvent[] {
    const out: CalendarEvent[] = [];
    for (let day = Math.floor(from / DAY_MS) * DAY_MS; day < to; day += DAY_MS) {
      for (const e of this.eventsForDay(day)) {
        const t = Date.parse(e.time);
        if (t >= from && t < to) out.push(e);
      }
    }
    return out;
  }

  private eventsForDay(day: number): CalendarEvent[] {
    const weekday = new Date(day).getUTCDay();
    if (weekday === 0 || weekday === 6) return [];
    const rng = new Prng(`${this.seed}|calendar|${day}`);
    const count = 3 + rng.int(4);
    const used = new Set<number>();
    const events: CalendarEvent[] = [];
    for (let i = 0; i < count; i++) {
      let slot = 12 + rng.int(28); // 06:00–19:30 UTC in 30-minute slots
      while (used.has(slot)) slot = 12 + ((slot - 11) % 28);
      used.add(slot);
      const t = TEMPLATES[rng.int(TEMPLATES.length)]!;
      const time = new Date(day + slot * 30 * 60_000).toISOString();
      events.push({
        id: `sim-${time.slice(0, 16)}-${t.country}`,
        time,
        country: t.country,
        currency: t.currency,
        impact: t.impact,
        title: t.title,
        source: this.source,
      });
    }
    return events.sort((a, b) => a.time.localeCompare(b.time));
  }
}

export function eventsToShocks(events: CalendarEvent[]): EventShock[] {
  return events.map((e) => ({
    id: e.id,
    ts: Date.parse(e.time),
    country: e.country,
    currency: e.currency,
    impact: e.impact,
  }));
}
