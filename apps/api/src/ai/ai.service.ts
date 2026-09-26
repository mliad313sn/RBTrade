import { Injectable, Logger } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { BudgetService, ResponseCacheService } from './budget.service';
import { loadAiConfig, UNAVAILABLE_MESSAGE, type AiConfig } from './core/config';
import { buildRequest, promptHashOf, runCopilot, type DraftRef } from './core/engine';
import type { GuardFlags } from './core/guards';
import type { ToolCallRecord } from './core/tools';
import type { AiAsk, AiProvider, ProviderUsage } from './core/types';
import { DISCLAIMER } from './core/types';
import { MetricsService } from './metrics.service';
import { friendlyProviderError } from './providers/anthropic.provider';
import { selectProvider } from './providers/select';
import { AiToolBackend } from './tool-backend.service';

export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string; outcome: string }
  | { type: 'final'; answer: AiAnswer };

export interface AiAnswerOk {
  status: 'ok';
  answer: string;
  flags: GuardFlags;
  drafts: DraftRef[];
  toolCalls: Array<{ name: string; outcome: string }>;
  modelId: string;
  promptHash: string;
  cached: boolean;
  usage: ProviderUsage;
  auditEventId: string;
  disclaimer: string;
}

export interface AiAnswerNotOk {
  status: 'unavailable' | 'budget_exceeded' | 'rate_limited' | 'error';
  message: string;
  retryAfterSeconds?: number;
  auditEventId?: string;
}

export type AiAnswer = AiAnswerOk | AiAnswerNotOk;

interface CachedAnswer {
  answer: string;
  flags: GuardFlags;
  toolCalls: Array<{ name: string; outcome: string }>;
  usage: ProviderUsage;
}

/**
 * The AI gateway: budget and rate limit → cache → engine (tools as the user) → guards → audit and
 * metrics. Every request, tool call and draft is audit-logged with the model id and prompt hash.
 */
@Injectable()
export class AiService {
  private readonly log = new Logger('AiService');
  private providerCache: { key: string; provider: AiProvider } | null = null;

  constructor(
    private readonly backend: AiToolBackend,
    private readonly budget: BudgetService,
    private readonly cache: ResponseCacheService,
    private readonly audit: AuditService,
    private readonly metrics: MetricsService,
  ) {}

  config(): AiConfig {
    return loadAiConfig();
  }

  /** Provider for the current config (re-created only when the config changes). */
  provider(cfg: AiConfig): { provider: AiProvider | null; reason: string | null } {
    const key = `${cfg.provider}|${cfg.model}|${cfg.persona}|${cfg.replayDir}|${cfg.recordDir}|${cfg.apiKeyPresent}|${cfg.thinking}|${cfg.effort}`;
    if (this.providerCache?.key === key)
      return { provider: this.providerCache.provider, reason: null };
    const sel = selectProvider(cfg);
    if (sel.provider) this.providerCache = { key, provider: sel.provider };
    return sel;
  }

  status() {
    const cfg = this.config();
    const sel = this.provider(cfg);
    return {
      available: !!sel.provider,
      message: sel.provider ? null : UNAVAILABLE_MESSAGE,
      reason: sel.reason,
      provider: cfg.provider,
      environment: 'PAPER',
    };
  }

  private async auditRequest(
    ask: AiAsk,
    payload: Record<string, string | number | boolean | null>,
  ): Promise<string> {
    const ev = await this.audit.record({
      actorId: ask.user.id,
      actorType: 'ai',
      action: 'ai.request',
      entity: 'ai',
      entityId: null,
      payload: { surface: ask.surface, mode: ask.mode, ...payload },
    });
    return ev.id;
  }

  private async auditTool(
    ask: AiAsk,
    modelId: string,
    promptHash: string,
    r: ToolCallRecord,
  ): Promise<void> {
    this.metrics.toolCalls.inc({
      tool: r.outcome === 'refused_unknown' ? 'unknown' : r.name,
      outcome: r.outcome,
    });
    await this.audit.record({
      actorId: ask.user.id,
      actorType: 'ai',
      action: 'ai.tool_call',
      entity: 'ai_tool',
      entityId: r.name,
      payload: {
        tool: r.name,
        outcome: r.outcome,
        kind: r.kind,
        inputHash: r.inputHash,
        modelId,
        promptHash,
        surface: ask.surface,
        durationMs: r.durationMs,
        refused: r.outcome.startsWith('refused'),
        error: r.error ? r.error.slice(0, 200) : null,
      },
    });
  }

  async ask(ask: AiAsk, onEvent?: (e: StreamEvent) => void): Promise<AiAnswer> {
    const started = Date.now();
    const cfg = this.config();
    const end = (a: AiAnswer, status: string) => {
      this.metrics.requests.inc({ surface: ask.surface, mode: ask.mode, status });
      this.metrics.duration.observe({ surface: ask.surface }, (Date.now() - started) / 1000);
      onEvent?.({ type: 'final', answer: a });
      return a;
    };

    const sel = this.provider(cfg);
    if (!sel.provider) {
      const auditEventId = await this.auditRequest(ask, {
        status: 'unavailable',
        modelId: null,
        reason: sel.reason,
      });
      return end(
        { status: 'unavailable', message: UNAVAILABLE_MESSAGE, auditEventId },
        'unavailable',
      );
    }
    const provider = sel.provider;

    const verdict = await this.budget.check(ask.user.id, cfg);
    if (!verdict.ok) {
      this.metrics.budgetDenials.inc({ scope: verdict.scope });
      const auditEventId = await this.auditRequest(ask, {
        status: verdict.scope,
        modelId: provider.modelId,
      });
      return end(
        {
          status: verdict.scope === 'rate' ? 'rate_limited' : 'budget_exceeded',
          message: verdict.message,
          retryAfterSeconds: verdict.retryAfterSeconds,
          auditEventId,
        },
        verdict.scope === 'rate' ? 'rate_limited' : 'budget_exceeded',
      );
    }

    const promptHash = promptHashOf(provider.modelId, buildRequest(ask, cfg.maxTokens));
    const hit = await this.cache.get<CachedAnswer>(provider.modelId, promptHash).catch(() => null);
    if (hit) {
      this.metrics.cacheHits.inc({ surface: ask.surface });
      const auditEventId = await this.auditRequest(ask, {
        status: 'ok',
        cached: true,
        modelId: provider.modelId,
        promptHash,
        inputTokens: 0,
        outputTokens: 0,
      });
      onEvent?.({ type: 'delta', text: hit.answer });
      return end(
        {
          status: 'ok',
          ...hit,
          drafts: [],
          modelId: provider.modelId,
          promptHash,
          cached: true,
          auditEventId,
          disclaimer: DISCLAIMER,
        },
        'ok',
      );
    }

    try {
      const res = await runCopilot(ask, {
        provider,
        backend: this.backend,
        maxTokens: cfg.maxTokens,
        maxToolRounds: cfg.maxToolRounds,
        hooks: {
          onText: (text) => onEvent?.({ type: 'delta', text }),
          onToolCall: async (r) => {
            onEvent?.({ type: 'tool', name: r.name, outcome: r.outcome });
            await this.auditTool(ask, provider.modelId, promptHash, r);
          },
        },
      });
      const total = res.usage.inputTokens + res.usage.outputTokens + res.usage.cacheWriteTokens;
      const used = await this.budget.add(ask.user.id, cfg, total);
      this.metrics.recordUsage(provider.modelId, ask.surface, res.usage, cfg);
      this.metrics.orgTokensUsed.set({ org: cfg.orgId }, used.orgUsed);
      this.metrics.orgTokenBudget.set({ org: cfg.orgId }, cfg.orgDailyTokens);
      if (res.flags.ungrounded.length) this.metrics.guardFlags.inc({ flag: 'ungrounded_numbers' });
      if (res.flags.executionClaim) this.metrics.guardFlags.inc({ flag: 'execution_claim' });
      if (res.flags.fallback) this.metrics.guardFlags.inc({ flag: 'novice_fallback' });
      const refused = res.toolCalls.filter((t) => t.outcome.startsWith('refused')).length;
      const auditEventId = await this.auditRequest(ask, {
        status: 'ok',
        cached: false,
        modelId: provider.modelId,
        promptHash,
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens,
        cacheReadTokens: res.usage.cacheReadTokens,
        cacheWriteTokens: res.usage.cacheWriteTokens,
        rounds: res.rounds,
        toolCalls: res.toolCalls.length,
        refusedToolCalls: refused,
        drafts: res.drafts.length,
        ungroundedNumbers: res.flags.ungrounded.length,
        executionClaim: res.flags.executionClaim,
        noviceFallback: res.flags.fallback,
        readabilityGrade: res.flags.grade === null ? null : res.flags.grade.toFixed(1),
        stopReason: res.stopReason,
      });
      const toolCalls = res.toolCalls.map((t) => ({ name: t.name, outcome: t.outcome }));
      const clean =
        !res.flags.ungrounded.length && !res.flags.executionClaim && !res.flags.fallback;
      if (!res.drafts.length && clean && res.stopReason === 'end_turn') {
        await this.cache
          .set(
            provider.modelId,
            promptHash,
            {
              answer: res.text,
              flags: res.flags,
              toolCalls,
              usage: res.usage,
            } satisfies CachedAnswer,
            cfg.cacheTtlSeconds,
          )
          .catch(() => undefined);
      }
      return end(
        {
          status: 'ok',
          answer: res.text,
          flags: res.flags,
          drafts: res.drafts,
          toolCalls,
          modelId: provider.modelId,
          promptHash,
          cached: false,
          usage: res.usage,
          auditEventId,
          disclaimer: DISCLAIMER,
        },
        'ok',
      );
    } catch (err) {
      const f = friendlyProviderError(err);
      this.log.warn(`copilot request failed: ${f.code} ${(err as Error).message}`);
      const auditEventId = await this.auditRequest(ask, {
        status: 'error',
        code: f.code,
        modelId: provider.modelId,
        promptHash,
      });
      return end({ status: 'error', message: f.message, auditEventId }, 'error');
    }
  }
}
