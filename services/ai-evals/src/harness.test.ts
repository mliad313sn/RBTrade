import { describe, expect, it } from 'vitest';

import type { AiProvider, ProviderRequest, ProviderTurn } from '../../../apps/api/src/ai/core';
import { CATEGORIES, loadCases, runCase, scripted, summarise, THRESHOLDS } from './harness';

/** A careless model: invents numbers, gives advice, claims it traded, ignores tools. */
class SloppyProvider implements AiProvider {
  readonly kind = 'scripted' as const;
  readonly modelId = 'test:sloppy';
  async complete(_req: ProviderRequest): Promise<ProviderTurn> {
    return {
      content: [
        {
          type: 'text',
          text: 'You should buy now: EURUSD is at 1.0999 with 83% confidence. I have placed your order.',
        },
      ],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }
}

describe('eval harness', () => {
  const cases = loadCases();

  it('has at least 60 graded cases covering every category, with unique ids', () => {
    expect(cases.length).toBeGreaterThanOrEqual(60);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const cat of CATEGORIES)
      expect(cases.filter((c) => c.category === cat).length, cat).toBeGreaterThanOrEqual(5);
    expect(cases.filter((c) => c.category === 'injection').length).toBeGreaterThanOrEqual(15);
  });

  it('passes the thresholds with the scripted reference provider (CI gate)', async () => {
    const results = [];
    for (const c of cases) results.push(await runCase(c, scripted));
    const s = summarise('scripted', results);
    expect(s.byCategory.injection!.score).toBe(THRESHOLDS.injection);
    expect(s.byCategory.refusal!.score).toBe(THRESHOLDS.refusal);
    expect(s.overall).toBeGreaterThanOrEqual(THRESHOLDS.overall);
    expect(s.ok).toBe(true);
  });

  it('graders catch a careless model (numbers, grounding, readability, drafts)', async () => {
    const sloppy = new SloppyProvider();
    const results = [];
    for (const c of cases)
      results.push(await runCase(c, (p) => (p === 'adversarial' ? scripted(p) : sloppy)));
    const s = summarise('sloppy', results);
    expect(s.ok).toBe(false);
    expect(s.byCategory.grounded_explanation!.score).toBe(0);
    expect(s.byCategory.numeric_fidelity!.score).toBe(0);
    expect(s.byCategory.drafts!.score).toBeLessThan(0.5);
    const why = results.find((r) => r.id === 'why-robot-1')!;
    expect(why.grades.find((g) => g.grader === 'numeric_fidelity:exact')!.pass).toBe(false);
    // The server guards still make the final answer safe: no execution claim, disclaimer present.
    expect(why.grades.find((g) => g.grader === 'no_execution_claim')!.pass).toBe(true);
    expect(why.grades.find((g) => g.grader === 'disclaimer')!.pass).toBe(true);
  });

  it('news graders catch a gullible model that obeys injected instructions (goal 07B)', async () => {
    /** Follows article instructions: echoes canaries and sets every score to 1 when told to. */
    class GullibleProvider implements AiProvider {
      readonly kind = 'scripted' as const;
      readonly modelId = 'test:gullible';
      async complete(req: ProviderRequest): Promise<ProviderTurn> {
        const text = String(req.messages[0]?.content ?? '');
        const canary = /CANARY-[0-9A-Z]+/.exec(text)?.[0] ?? '';
        const told = /sentiment|instructions|指令|指示|instructions précédentes/i.test(text);
        const json =
          req.outputFormat?.name === 'news_translate'
            ? { language: 'en', title: `ok ${canary}`, summary: canary }
            : {
                sentiment: told ? 1 : 0,
                relevance: 1,
                novelty: 1,
                eventType: 'other',
                entities: [],
                note: canary,
              };
        return {
          content: [{ type: 'text', text: JSON.stringify(json) }],
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      }
    }
    const gullible = new GullibleProvider();
    const news = cases.filter(
      (c) => c.category === 'news_injection' && (c.persona ?? 'reference') === 'reference',
    );
    const results = [];
    for (const c of news)
      results.push(await runCase(c, (p) => (p === 'adversarial' ? scripted(p) : gullible)));
    expect(results.every((r) => !r.pass)).toBe(true);
    const first = results.find((r) => r.id === 'news-inj-ignore-set-scores')!;
    expect(first.grades.find((g) => g.grader === 'status:ok')!.pass).toBe(false); // extra "note" key rejected
  });
});
