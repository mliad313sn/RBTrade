import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KILL_SWITCH_SCOPES, noviceTemplates, RISK_CODES, type RiskFactor } from '@kora/domain';
import { describe, expect, it } from 'vitest';

import appropriateness from '../../../../api/src/appropriateness/questionnaires/appropriateness.v1.json';
import knowledgeCheck from '../../../../api/src/appropriateness/questionnaires/knowledge-check.v1.json';
import { GLOSSARY, lessonKeys, LESSONS } from '../novice/learn';
import { en } from './en';
import { fr } from './fr';
import { hasKey, interpolate, pickLocale, plain, translate } from './index';

/**
 * CI check (goal 08 §9, B-013): EN and FR have the same keys, no empty values, the same variables and
 * glossary links; every key the Novice code uses exists; dynamic key families are complete; the
 * French knowledge-check overlay matches the graded English data. Run: `pnpm --filter @kora/web i18n:check`.
 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const NOVICE_SOURCES = [
  'app/(app)/home',
  'app/(app)/practice',
  'app/(app)/auto-invest',
  'app/(app)/learn',
  'app/(app)/onboarding',
  'app/(app)/settings',
  'app/offline',
  'components/novice',
  'components/sim/Practice.tsx',
  'components/shell',
  'lib/novice',
];

function files(p: string): string[] {
  const full = join(SRC, p);
  if (statSync(full).isFile()) return [full];
  return readdirSync(full).flatMap((f) => files(join(p, f)));
}

const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const terms = (s: string) => [...s.matchAll(/\]\(term:([a-z0-9-]+)\)/g)].map((m) => m[1]).sort();

describe('i18n catalogue (EN source of truth, FR complete)', () => {
  const enKeys = Object.keys(en).sort();
  const frKeys = Object.keys(fr).sort();

  it('EN and FR have exactly the same keys and no empty values', () => {
    expect(frKeys.filter((k) => !(k in en))).toEqual([]);
    expect(enKeys.filter((k) => !(k in fr))).toEqual([]);
    expect(
      Object.entries(en)
        .filter(([, v]) => !v.trim())
        .map(([k]) => k),
    ).toEqual([]);
    expect(
      Object.entries(fr)
        .filter(([, v]) => !v.trim())
        .map(([k]) => k),
    ).toEqual([]);
  });

  it('each FR string keeps the same variables and glossary links as EN', () => {
    const bad = enKeys.filter((k) => {
      const f = fr[k as keyof typeof fr];
      const e = en[k as keyof typeof en];
      return (
        JSON.stringify(vars(e)) !== JSON.stringify(vars(f)) ||
        JSON.stringify(terms(e)) !== JSON.stringify(terms(f))
      );
    });
    expect(bad).toEqual([]);
  });

  it('every glossary link points at a Learn entry', () => {
    const all = [...Object.values(en), ...Object.values(fr)].flatMap(terms);
    expect(
      [...new Set(all)].filter((id) => !(GLOSSARY as readonly string[]).includes(id!)),
    ).toEqual([]);
    for (const id of GLOSSARY)
      expect(hasKey(`term.${id}.name`) && hasKey(`term.${id}.meaning`)).toBe(true);
  });

  it('every literal key used in the Novice code exists', () => {
    const used = new Set<string>();
    for (const f of NOVICE_SOURCES.flatMap(files).filter(
      (x) => /\.tsx?$/.test(x) && !x.endsWith('.test.ts'),
    )) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.-]+)'/g)) used.add(m[1]!);
      for (const m of src.matchAll(/\bk="([a-zA-Z0-9_.-]+)"/g)) used.add(m[1]!);
    }
    expect(used.size).toBeGreaterThan(150);
    expect([...used].filter((k) => !hasKey(k)).sort()).toEqual([]);
  });

  it('dynamic key families are complete', () => {
    const need: string[] = [
      ...RISK_CODES.map((c) => `risk.${c}`),
      ...KILL_SWITCH_SCOPES.flatMap((s) => [`kill.scope.${s}.title`, `kill.scope.${s}.detail`]),
      ...noviceTemplates().flatMap((t) => [`ai.t.${t.id}.name`, `ai.t.${t.id}.summary`]),
      ...(
        [
          'calm_markets',
          'mixed_markets',
          'crypto_markets',
          'single_market',
          'wide_safety_net',
          'small_amounts',
        ] satisfies RiskFactor[]
      ).map((f) => `ai.factor.${f}`),
      ...['knowledge_check', 'promotion_rules', 'live_trading_enabled'].map((x) => `ai.live.${x}`),
      ...[
        'onboarding_required',
        'amount_out_of_range',
        'already_added',
        'cooling_off',
        'trading_halted',
      ].map((x) => `ai.err.${x}`),
      ...['losing_trades', 'daily_loss_pct', 'daily_loss_limit'].map((x) => `cool.${x}`),
      ...['dailyLossLimit', 'monthlyLossLimit', 'noviceMaxLeverage', 'other'].map(
        (x) => `limits.pending.${x}`,
      ),
      ...LESSONS.flatMap((id) => {
        const k = lessonKeys(id);
        return [k.title, k.summary, ...k.paragraphs];
      }),
      ...['rarely', 'weekly', 'daily'].flatMap((x) => [
        `practice.often.${x}`,
        `practice.often.${x}.hint`,
      ]),
      ...['very', 'balanced', 'bold'].flatMap((x) => [
        `practice.careful.${x}`,
        `practice.careful.${x}.hint`,
      ]),
      ...['good', 'typical', 'bad'].flatMap((x) => [`practice.${x}`, `practice.${x}.explain`]),
      ...['simulation', 'costs', 'safety-net', 'range'].flatMap((x) => [
        `term.${x}.name`,
        `term.${x}.meaning`,
      ]),
      ...['blue_orange', 'green_red', 'red_up_asia'].map((x) => `settings.colours.${x}`),
    ];
    expect(need.filter((k) => !hasKey(k))).toEqual([]);
  });

  it('the knowledge-check copy matches the graded data (EN) and is translated (FR)', () => {
    for (const q of knowledgeCheck.questions) {
      expect(en[`kc.q.${q.id}.prompt` as keyof typeof en]).toBe(q.prompt);
      expect(fr[`kc.q.${q.id}.prompt` as keyof typeof fr]).not.toBe(q.prompt);
      for (const o of q.options)
        expect(en[`kc.q.${q.id}.${o.id}` as keyof typeof en]).toBe(o.label);
      expect(hasKey(`kc.topic.${q.topic}`)).toBe(true);
    }
  });

  it('the appropriateness copy matches the graded data (EN) and is translated (FR) (IRTC R5-12)', () => {
    const e = en as Record<string, string>;
    const f = fr as Record<string, string>;
    expect(e['appr.q.title']).toBe(appropriateness.title);
    expect(e['appr.q.intro']).toBe(appropriateness.intro);
    expect(f['appr.q.title']).not.toBe(appropriateness.title);
    for (const q of appropriateness.questions) {
      expect(e[`appr.q.${q.id}.prompt`]).toBe(q.prompt);
      expect(f[`appr.q.${q.id}.prompt`]).not.toBe(q.prompt);
      expect(e[`appr.topic.${q.id}`]).toBe(q.topic);
      expect(f[`appr.topic.${q.id}`]).toBeTruthy();
      for (const o of q.options) {
        expect(e[`appr.q.${q.id}.${o.id}`]).toBe(o.label);
        expect(f[`appr.q.${q.id}.${o.id}`]).toBeTruthy();
      }
    }
  });

  it('runtime helpers: locale pick, interpolation, markup stripping, fallback', () => {
    expect(pickLocale('fr', 'en-GB')).toBe('fr');
    expect(pickLocale(undefined, 'fr-CA,fr;q=0.9,en;q=0.8')).toBe('fr');
    expect(pickLocale('de', 'de-DE')).toBe('en');
    expect(interpolate('Hi {name}, {missing}', { name: 'Ana' })).toBe('Hi Ana, {missing}');
    expect(plain('A [net](term:safety-net) of **5**')).toBe('A net of 5');
    expect(translate('fr', 'nav.home')).toBe('Accueil');
    expect(translate('en', 'trade.min', { name: 'Gold', amount: '$1' })).toBe(
      'The smallest amount for Gold is $1.',
    );
  });
});
