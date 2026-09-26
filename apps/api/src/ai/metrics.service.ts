import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

import type { AiConfig } from './core/config';
import type { ProviderUsage } from './core/types';

/**
 * Prometheus metrics for the copilot (tokens, cost, requests, tool calls, budget denials, cache).
 * Served at GET /metrics; the Grafana dashboard is `infra/grafana/dashboards/ai-copilot.json`.
 * Cost uses the env prices (`KORA_AI_PRICE_*_USD_PER_MTOK`); the repo holds no model prices.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  readonly requests = new Counter({
    name: 'kora_ai_requests_total',
    help: 'Copilot requests by surface, mode and status',
    labelNames: ['surface', 'mode', 'status'] as const,
    registers: [this.registry],
  });
  readonly tokens = new Counter({
    name: 'kora_ai_tokens_total',
    help: 'Tokens by model, surface and kind (input, output, cache_read, cache_write)',
    labelNames: ['model', 'surface', 'kind'] as const,
    registers: [this.registry],
  });
  readonly cost = new Counter({
    name: 'kora_ai_cost_usd_total',
    help: 'Estimated cost in USD from the configured per-token prices',
    labelNames: ['model', 'surface'] as const,
    registers: [this.registry],
  });
  readonly toolCalls = new Counter({
    name: 'kora_ai_tool_calls_total',
    help: 'Tool calls by tool and outcome (ok, refused_unknown, refused_role, refused_mode, invalid_input, error)',
    labelNames: ['tool', 'outcome'] as const,
    registers: [this.registry],
  });
  readonly budgetDenials = new Counter({
    name: 'kora_ai_budget_denials_total',
    help: 'Requests refused with a friendly message by budget or rate limit',
    labelNames: ['scope'] as const,
    registers: [this.registry],
  });
  readonly cacheHits = new Counter({
    name: 'kora_ai_cache_hits_total',
    help: 'Answers served from the response cache',
    labelNames: ['surface'] as const,
    registers: [this.registry],
  });
  readonly guardFlags = new Counter({
    name: 'kora_ai_guard_flags_total',
    help: 'Output guard interventions (ungrounded_numbers, execution_claim, novice_fallback)',
    labelNames: ['flag'] as const,
    registers: [this.registry],
  });
  readonly duration = new Histogram({
    name: 'kora_ai_request_duration_seconds',
    help: 'Copilot request latency',
    labelNames: ['surface'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 40],
    registers: [this.registry],
  });
  readonly orgTokensUsed = new Gauge({
    name: 'kora_ai_org_tokens_used',
    help: 'Tokens used today by the organisation (budget window, UTC day)',
    labelNames: ['org'] as const,
    registers: [this.registry],
  });
  readonly orgTokenBudget = new Gauge({
    name: 'kora_ai_org_token_budget',
    help: 'Daily organisation token budget',
    labelNames: ['org'] as const,
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: 'kora_api_' });
  }

  recordUsage(model: string, surface: string, u: ProviderUsage, cfg: AiConfig): void {
    this.tokens.inc({ model, surface, kind: 'input' }, u.inputTokens);
    this.tokens.inc({ model, surface, kind: 'output' }, u.outputTokens);
    this.tokens.inc({ model, surface, kind: 'cache_read' }, u.cacheReadTokens);
    this.tokens.inc({ model, surface, kind: 'cache_write' }, u.cacheWriteTokens);
    const usd =
      (u.inputTokens * cfg.prices.input +
        u.outputTokens * cfg.prices.output +
        u.cacheReadTokens * cfg.prices.cacheRead +
        u.cacheWriteTokens * cfg.prices.cacheWrite) /
      1_000_000;
    this.cost.inc({ model, surface }, usd);
  }
}
