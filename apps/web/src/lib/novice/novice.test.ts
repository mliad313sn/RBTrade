import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NoviceTicketResponse } from '@kora/sdk';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

import { fmtMoney } from '../i18n/format';
import { makeT } from '../i18n';
import { isPublicPath } from '../route-rules';
import {
  assetName,
  currencyWord,
  parseShownMoney,
  riskReasons,
  sinceText,
  ticketDisplay,
} from './view';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Seeded PRNG (no Math.random in this repo). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ticket(
  total: string,
  price: string,
  costs: string,
  currency = 'USD',
): NoviceTicketResponse {
  return {
    ok: true,
    order: {
      symbol: 'EURUSD',
      side: 'buy',
      type: 'market',
      qty: '1000',
      stopLossPrice: '1.05',
      tif: 'gtc',
      reduceOnly: false,
      postOnly: false,
      source: 'manual',
    },
    refPrice: '1.08',
    amountUsed: '1084.20',
    minAmount: '1084.20',
    safetyNetPct: '3',
    currency,
    preview: {
      preview: { lossIfStopHit: { stopPrice: '1.05', price, costs, total, pctEquity: '0.03' } },
      risk: { ok: true, violations: [] },
    } as never,
    scenario: { loss: total, gain: '0' },
  };
}

describe('"most you could lose" shows exactly the preview value (20 randomised cases, EN and FR)', () => {
  it('formats the preview total and parses back to the same decimal', () => {
    const r = rng(8);
    for (let i = 0; i < 20; i++) {
      const cents = Math.floor(r() * 5_000_000) + 1;
      const costsCents = Math.floor(r() * 5_000);
      const total = (cents / 100).toFixed(2);
      const costs = (costsCents / 100).toFixed(2);
      const price = ((cents - costsCents) / 100).toFixed(2);
      for (const locale of ['en', 'fr'] as const) {
        const d = ticketDisplay(ticket(total, price, costs), locale)!;
        expect(d.raw.mostYouCouldLose).toBe(total);
        expect(parseShownMoney(d.mostYouCouldLose, locale)).toBe(total);
        expect(parseShownMoney(d.fees, locale)).toBe(costs);
      }
    }
    expect(ticketDisplay({ ok: false, reason: 'no_price', minAmount: null }, 'en')).toBeNull();
    expect(ticketDisplay(null, 'en')).toBeNull();
  });

  it('money formats: EN symbol first, FR narrow spaces and symbol last, JPY without decimals', () => {
    expect(fmtMoney('10482.3', 'USD', 'en')).toBe('$10,482.30');
    expect(fmtMoney('-214', 'USD', 'en', { signed: true })).toBe('−$214.00');
    expect(fmtMoney('10482.3', 'USD', 'fr')).toBe('10 482,30 $');
    expect(fmtMoney('1500', 'JPY', 'fr')).toBe('1 500 ¥');
    expect(fmtMoney('abc', 'USD', 'en')).toBe('—');
  });
});

describe('novice view helpers', () => {
  const t = makeT('en');
  it('names, risk reasons, since, currency words', () => {
    expect(assetName({ en: 'Gold', fr: 'Or' }, 'fr', 'XAU/USD')).toBe('Or');
    expect(assetName(null, 'fr', 'XAU/USD')).toBe('XAU/USD');
    expect(
      riskReasons(
        [{ code: 'NOVICE_COOLING_OFF' }, { code: 'NOVICE_COOLING_OFF' }, { code: 'NEW_CODE' }],
        t,
      ),
    ).toEqual([
      'Time for a break. New trades open again tomorrow. You can still close trades.',
      'This trade can’t go through right now.',
    ]);
    const now = Date.parse('2026-09-30T12:00:00Z');
    expect(sinceText('2026-09-30T08:00:00Z', now, t)).toBe('today');
    expect(sinceText('2026-09-27T08:00:00Z', now, t)).toBe('3 days');
    expect(sinceText('2026-09-22T08:00:00Z', now, t)).toBe('1 week');
    expect(sinceText('2026-08-19T08:00:00Z', now, t)).toBe('6 weeks');
    expect(currencyWord('USD', t)).toBe('dollars');
    expect(currencyWord('ZAR', t)).toBe('ZAR');
  });

  it('PWA files and the offline shell are reachable without a session', () => {
    for (const p of ['/sw.js', '/manifest.webmanifest', '/offline', '/icons/icon-192.png'])
      expect(isPublicPath(p)).toBe(true);
    expect(isPublicPath('/home')).toBe(false);
  });
});

describe('service worker: offline shell only, no push nudges', () => {
  const sw = readFileSync(join(WEB, 'public/sw.js'), 'utf8');
  it('precaches the offline page, never caches /api, has no push or notification handlers', () => {
    expect(sw).toContain("const OFFLINE_URL = '/offline'");
    expect(sw).toMatch(/startsWith\('\/api\/'\)\) return/);
    expect(sw).not.toMatch(/addEventListener\(\s*['"](push|notificationclick|sync)['"]/);
    expect(sw).not.toMatch(/showNotification|pushManager|PushManager/);
  });
});

describe('no gamification lint (goal 08 §9)', () => {
  const eslint = new ESLint({ cwd: WEB });
  const lint = async (code: string, file: string) =>
    (await eslint.lintText(code, { filePath: join(WEB, file) }))[0]!.messages;

  it('forbids confetti, streak and leaderboard components and imports in novice files', async () => {
    const bad = [
      "import Confetti from 'react-confetti';\nexport const A = () => <Confetti />;\n",
      "import { StreakBadge } from '@/components/StreakBadge';\nexport const A = () => <StreakBadge />;\n",
      'export const A = () => <Ui.Leaderboard />;\n',
      "export async function a() { await import('canvas-confetti'); }\n",
    ];
    for (const code of bad) {
      const msgs = await lint(code, 'src/components/novice/Fixture.tsx');
      expect(
        msgs.some((m) => /No gamification/.test(m.message)),
        code,
      ).toBe(true);
    }
    for (const file of [
      'src/app/(app)/home/page.tsx',
      'src/components/sim/Practice.tsx',
      'src/lib/novice/x.ts',
      'src/components/ai/ExplainThis.tsx',
      'src/components/intel/WhatsMovingCard.tsx',
    ]) {
      const msgs = await lint("import c from 'canvas-confetti';\nexport const x = c;\n", file);
      expect(
        msgs.some((m) => /No gamification/.test(m.message)),
        file,
      ).toBe(true);
    }
  }, 30_000);

  it('does not touch Pro files, and the real novice files pass', async () => {
    const pro = await lint(
      "import c from 'canvas-confetti';\nexport const x = c;\n",
      'src/components/robots/Fixture.tsx',
    );
    expect(pro.some((m) => /No gamification/.test(m.message))).toBe(false);
    const results = await eslint.lintFiles([
      'src/components/novice/**/*.tsx',
      'src/app/(app)/home/**/*.tsx',
      'src/lib/novice/**/*.tsx',
      'src/components/ai/ExplainThis.tsx',
      'src/components/intel/WhatsMovingCard.tsx',
    ]);
    expect(
      results.flatMap((r) => r.messages.filter((m) => /No gamification/.test(m.message))),
    ).toEqual([]);
  }, 60_000);
});
