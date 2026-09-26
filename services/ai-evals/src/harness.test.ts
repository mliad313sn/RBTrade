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
});
