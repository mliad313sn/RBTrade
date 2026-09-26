import type { SessionCalendar, Venue } from '@kora/domain';

/**
 * SIMULATED sample venue set (goal 02, global registry). MICs are ISO 10383 codes, except KSIM
 * and KCRY which are KORA's non-ISO simulated OTC venues (isoMic = false). Session hours are
 * simplified regular hours; holiday lists are a small 2026 sample, not an authoritative calendar
 * (OQ-M2). Replace with a licensed reference-data feed before any real use.
 */

const CAL_SOURCE = 'SIMULATED sample calendar (regular hours + partial 2026 holidays); not authoritative, see OQ-M2';

type R = [string, string];
const weekdays = (...ranges: R[]): SessionCalendar['weekly'] => ({
  mon: ranges,
  tue: ranges,
  wed: ranges,
  thu: ranges,
  fri: ranges,
});
const h = (...list: Array<[string, string]>) => list.map(([date, name]) => ({ date, name }));

const US_EQUITY: SessionCalendar = {
  weekly: weekdays(['09:30', '16:00']),
  holidays: h(
    ['2026-01-01', "New Year's Day"],
    ['2026-01-19', 'Martin Luther King Jr. Day'],
    ['2026-02-16', "Washington's Birthday"],
    ['2026-04-03', 'Good Friday'],
    ['2026-05-25', 'Memorial Day'],
    ['2026-06-19', 'Juneteenth'],
    ['2026-07-03', 'Independence Day (observed)'],
    ['2026-09-07', 'Labor Day'],
    ['2026-11-26', 'Thanksgiving Day'],
    ['2026-12-25', 'Christmas Day'],
  ),
  earlyCloses: [
    { date: '2026-11-27', close: '13:00', name: 'Day after Thanksgiving' },
    { date: '2026-12-24', close: '13:00', name: 'Christmas Eve' },
  ],
};

/** Near-24h futures convention with a daily maintenance break (local time of the venue). */
const GLOBEX_LIKE: SessionCalendar = {
  weekly: {
    sun: [['17:00', '24:00']],
    mon: [['00:00', '16:00'], ['17:00', '24:00']],
    tue: [['00:00', '16:00'], ['17:00', '24:00']],
    wed: [['00:00', '16:00'], ['17:00', '24:00']],
    thu: [['00:00', '16:00'], ['17:00', '24:00']],
    fri: [['00:00', '16:00']],
  },
  holidays: h(['2026-01-01', "New Year's Day"], ['2026-12-25', 'Christmas Day']),
};

/** FX 24x5 on the New York 17:00 convention. */
export const FX_24X5: SessionCalendar = {
  weekly: {
    sun: [['17:00', '24:00']],
    mon: [['00:00', '24:00']],
    tue: [['00:00', '24:00']],
    wed: [['00:00', '24:00']],
    thu: [['00:00', '24:00']],
    fri: [['00:00', '17:00']],
  },
  holidays: h(['2026-12-25', 'Christmas Day'], ['2026-01-01', "New Year's Day"]),
};

export const ALWAYS_OPEN: SessionCalendar = {
  weekly: Object.fromEntries(
    (['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const).map((d) => [d, [['00:00', '24:00'] as R]]),
  ),
};

const v = (x: Omit<Venue, 'calendarSource' | 'status' | 'simulated' | 'isoMic'> & { isoMic?: boolean }): Venue => ({
  isoMic: true,
  calendarSource: CAL_SOURCE,
  status: 'active',
  simulated: true,
  ...x,
});

export const SEED_VENUES: Venue[] = [
  // North America
  v({ mic: 'XNYS', operatingMic: 'XNYS', name: 'New York Stock Exchange', country: 'US', region: 'north_america', timezone: 'America/New_York', currency: 'USD', calendar: US_EQUITY }),
  v({ mic: 'XNAS', operatingMic: 'XNAS', name: 'Nasdaq', country: 'US', region: 'north_america', timezone: 'America/New_York', currency: 'USD', calendar: US_EQUITY }),
  v({ mic: 'ARCX', operatingMic: 'XNYS', name: 'NYSE Arca', country: 'US', region: 'north_america', timezone: 'America/New_York', currency: 'USD', calendar: US_EQUITY }),
  v({ mic: 'XCBO', operatingMic: 'XCBO', name: 'Cboe Options Exchange', country: 'US', region: 'north_america', timezone: 'America/Chicago', currency: 'USD', calendar: { ...US_EQUITY, weekly: weekdays(['08:30', '15:00']), earlyCloses: [] } }),
  v({ mic: 'XCME', operatingMic: 'XCME', name: 'Chicago Mercantile Exchange', country: 'US', region: 'north_america', timezone: 'America/Chicago', currency: 'USD', calendar: GLOBEX_LIKE }),
  v({ mic: 'XTSE', operatingMic: 'XTSE', name: 'Toronto Stock Exchange', country: 'CA', region: 'north_america', timezone: 'America/Toronto', currency: 'CAD', calendar: { weekly: weekdays(['09:30', '16:00']), holidays: h(['2026-01-01', "New Year's Day"], ['2026-07-01', 'Canada Day'], ['2026-12-25', 'Christmas Day']) } }),
  // South America
  v({ mic: 'BVMF', operatingMic: 'BVMF', name: 'B3 (Brasil Bolsa Balcão)', country: 'BR', region: 'south_america', timezone: 'America/Sao_Paulo', currency: 'BRL', calendar: { weekly: weekdays(['10:00', '17:00']), holidays: h(['2026-01-01', 'Confraternização Universal'], ['2026-12-25', 'Natal']) } }),
  // Europe
  v({ mic: 'XLON', operatingMic: 'XLON', name: 'London Stock Exchange', country: 'GB', region: 'europe', timezone: 'Europe/London', currency: 'GBP', calendar: { weekly: weekdays(['08:00', '16:30']), holidays: h(['2026-01-01', "New Year's Day"], ['2026-04-03', 'Good Friday'], ['2026-04-06', 'Easter Monday'], ['2026-05-04', 'Early May bank holiday'], ['2026-05-25', 'Spring bank holiday'], ['2026-08-31', 'Summer bank holiday'], ['2026-12-25', 'Christmas Day'], ['2026-12-28', 'Boxing Day (substitute)']), earlyCloses: [{ date: '2026-12-24', close: '12:30' }, { date: '2026-12-31', close: '12:30' }] } }),
  v({ mic: 'XETR', operatingMic: 'XFRA', name: 'Xetra', country: 'DE', region: 'europe', timezone: 'Europe/Berlin', currency: 'EUR', calendar: { weekly: weekdays(['09:00', '17:30']), holidays: h(['2026-01-01', 'Neujahr'], ['2026-04-03', 'Karfreitag'], ['2026-04-06', 'Ostermontag'], ['2026-05-01', 'Tag der Arbeit'], ['2026-12-24', 'Heiligabend'], ['2026-12-25', 'Weihnachten'], ['2026-12-31', 'Silvester']) } }),
  v({ mic: 'XPAR', operatingMic: 'XPAR', name: 'Euronext Paris', country: 'FR', region: 'europe', timezone: 'Europe/Paris', currency: 'EUR', calendar: { weekly: weekdays(['09:00', '17:30']), holidays: h(['2026-01-01', "Jour de l'an"], ['2026-04-03', 'Vendredi saint'], ['2026-04-06', 'Lundi de Pâques'], ['2026-05-01', 'Fête du Travail'], ['2026-12-25', 'Noël']) } }),
  // Asia
  v({ mic: 'XTKS', operatingMic: 'XJPX', name: 'Tokyo Stock Exchange', country: 'JP', region: 'asia', timezone: 'Asia/Tokyo', currency: 'JPY', calendar: { weekly: weekdays(['09:00', '11:30'], ['12:30', '15:30']), holidays: h(['2026-01-01', 'New Year'], ['2026-01-02', 'Market holiday'], ['2026-12-31', 'Market holiday']) } }),
  v({ mic: 'XHKG', operatingMic: 'XHKG', name: 'Hong Kong Exchanges and Clearing', country: 'HK', region: 'asia', timezone: 'Asia/Hong_Kong', currency: 'HKD', calendar: { weekly: weekdays(['09:30', '12:00'], ['13:00', '16:00']), holidays: h(['2026-01-01', 'New Year'], ['2026-12-25', 'Christmas Day']) } }),
  v({ mic: 'XSHG', operatingMic: 'XSHG', name: 'Shanghai Stock Exchange', country: 'CN', region: 'asia', timezone: 'Asia/Shanghai', currency: 'CNY', calendar: { weekly: weekdays(['09:30', '11:30'], ['13:00', '15:00']), holidays: h(['2026-01-01', 'New Year']) } }),
  v({ mic: 'XNSE', operatingMic: 'XNSE', name: 'National Stock Exchange of India', country: 'IN', region: 'asia', timezone: 'Asia/Kolkata', currency: 'INR', calendar: { weekly: weekdays(['09:15', '15:30']), holidays: h(['2026-01-26', 'Republic Day'], ['2026-10-02', 'Gandhi Jayanti']) } }),
  // Africa
  v({ mic: 'XJSE', operatingMic: 'XJSE', name: 'Johannesburg Stock Exchange', country: 'ZA', region: 'africa', timezone: 'Africa/Johannesburg', currency: 'ZAR', calendar: { weekly: weekdays(['09:00', '17:00']), holidays: h(['2026-01-01', "New Year's Day"], ['2026-04-03', 'Good Friday'], ['2026-04-06', 'Family Day'], ['2026-04-27', 'Freedom Day'], ['2026-12-16', 'Day of Reconciliation'], ['2026-12-25', 'Christmas Day']) } }),
  // Oceania
  v({ mic: 'XASX', operatingMic: 'XASX', name: 'Australian Securities Exchange', country: 'AU', region: 'oceania', timezone: 'Australia/Sydney', currency: 'AUD', calendar: { weekly: weekdays(['10:00', '16:00']), holidays: h(['2026-01-01', "New Year's Day"], ['2026-01-26', 'Australia Day'], ['2026-04-03', 'Good Friday'], ['2026-04-06', 'Easter Monday'], ['2026-12-25', 'Christmas Day'], ['2026-12-28', 'Boxing Day (substitute)']) } }),
  v({ mic: 'XNZE', operatingMic: 'XNZE', name: 'New Zealand Exchange', country: 'NZ', region: 'oceania', timezone: 'Pacific/Auckland', currency: 'NZD', calendar: { weekly: weekdays(['10:00', '16:45']), holidays: h(['2026-01-01', "New Year's Day"], ['2026-02-06', 'Waitangi Day']) } }),
  // Simulated OTC venues (not ISO 10383)
  v({ mic: 'KSIM', isoMic: false, operatingMic: null, name: 'KORA Simulated OTC (FX, CFD, bonds, funds)', country: 'US', region: 'global', timezone: 'America/New_York', currency: 'USD', calendar: FX_24X5 }),
  v({ mic: 'KCRY', isoMic: false, operatingMic: null, name: 'KORA Simulated Crypto', country: 'US', region: 'global', timezone: 'UTC', currency: 'USD', calendar: ALWAYS_OPEN }),
];

export const GLOBEX_LIKE_CALENDAR = GLOBEX_LIKE;
