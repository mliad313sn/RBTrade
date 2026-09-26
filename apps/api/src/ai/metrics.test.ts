import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadAiConfig } from './core/config';
import { MetricsService } from './metrics.service';

describe('copilot metrics and the committed Grafana dashboard', () => {
  it('every kora_ai_* series used by infra/grafana dashboard exists in the registry', async () => {
    const m = new MetricsService();
    const registered = new Set((await m.registry.getMetricsAsJSON()).map((x) => x.name));
    const dash = readFileSync(
      resolve(__dirname, '../../../../infra/grafana/provisioning/dashboards/ai-copilot.json'),
      'utf8',
    );
    const used = new Set(
      [...dash.matchAll(/kora_ai_[a-z_]+/g)].map((x) => x[0].replace(/_bucket$/, '')),
    );
    expect(used.size).toBeGreaterThan(6);
    for (const name of used) expect(registered, name).toContain(name);
  });

  it('counts tokens and cost from env prices (no model prices in the repo)', async () => {
    const m = new MetricsService();
    const cfg = loadAiConfig({
      KORA_AI_PRICE_INPUT_USD_PER_MTOK: '2',
      KORA_AI_PRICE_OUTPUT_USD_PER_MTOK: '10',
    });
    m.recordUsage(
      'model-x',
      'chat',
      { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      cfg,
    );
    const text = await m.registry.metrics();
    expect(text).toContain(
      'kora_ai_tokens_total{model="model-x",surface="chat",kind="input"} 1000000',
    );
    expect(text).toContain('kora_ai_cost_usd_total{model="model-x",surface="chat"} 3');
  });
});
