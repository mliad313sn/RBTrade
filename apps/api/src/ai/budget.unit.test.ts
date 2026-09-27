import { describe, expect, it } from 'vitest';

import { BudgetService } from './budget.service';
import { loadAiConfig } from './core/config';

/** Minimal in-memory Redis for the commands BudgetService uses. */
function fakeRedis() {
  const kv = new Map<string, number>();
  const incrby = (k: string, n: number) => {
    const v = (kv.get(k) ?? 0) + n;
    kv.set(k, v);
    return v;
  };
  const client = {
    status: 'ready',
    incr: async (k: string) => incrby(k, 1),
    incrby: async (k: string, n: number) => incrby(k, n),
    decrby: async (k: string, n: number) => incrby(k, -n),
    expire: async () => 1,
    mget: async (...keys: string[]) => keys.map((k) => (kv.has(k) ? String(kv.get(k)) : null)),
    multi() {
      const ops: Array<() => unknown> = [];
      const chain = {
        incrby: (k: string, n: number) => (ops.push(() => incrby(k, n)), chain),
        expire: () => (ops.push(() => 1), chain),
        exec: async () => ops.map((op) => [null, op()]),
      };
      return chain;
    },
  };
  return { kv, service: new BudgetService({ client } as never) };
}

describe('AI budgets (IRTC R4-20)', () => {
  it('reserves tokens at check time, so parallel requests cannot all pass a nearly spent budget', async () => {
    const { service } = fakeRedis();
    const cfg = {
      ...loadAiConfig({
        KORA_AI_USER_DAILY_TOKENS: '5000',
        KORA_AI_MAX_TOKENS: '4096',
      } as NodeJS.ProcessEnv),
    };
    const verdicts = await Promise.all([1, 2, 3].map(() => service.check('u1', cfg)));
    expect(verdicts.filter((v) => v.ok)).toHaveLength(2);
    // Settling with the real usage releases the unused part of the reservation.
    const ok = verdicts.filter((v) => v.ok) as Array<{ reserved: number }>;
    await service.add('u1', cfg, 100, ok[0]!.reserved);
    await service.release('u1', cfg, ok[1]!.reserved);
    expect((await service.usage('u1', cfg)).userUsed).toBe(100);
  });

  it('the news pipeline spends its own budget, never the copilot organisation budget', async () => {
    const { service } = fakeRedis();
    const cfg = loadAiConfig({
      KORA_AI_ORG_DAILY_TOKENS: '1000',
      KORA_AI_PIPELINE_DAILY_TOKENS: '50000',
    } as NodeJS.ProcessEnv);
    await service.addPipeline(cfg, 40_000);
    expect(await service.pipelineUsage(cfg)).toMatchObject({ used: 40_000, budget: 50_000 });
    expect((await service.check('u2', cfg)).ok).toBe(true);
  });
});
