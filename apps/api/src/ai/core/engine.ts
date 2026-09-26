import type Anthropic from '@anthropic-ai/sdk';

import { applyGuards, type GuardFlags } from './guards';
import { hashOf } from './hash';
import { systemPrompt, userTurn } from './prompts';
import {
  dispatchTool,
  toolsFor,
  type ToolBackend,
  type ToolCallCtx,
  type ToolCallRecord,
} from './tools';
import type { AiAsk, AiProvider, ProviderRequest, ProviderUsage } from './types';

/**
 * The conversation engine: one grounded question → tool rounds → guarded answer. Framework-free, so
 * the api (DB-backed tools), the integration tests and the eval harness (fixture tools) run the
 * exact same code path.
 */

export interface DraftRef {
  kind: 'order' | 'strategy';
  id: string;
  /** Order drafts: the TicketDraft prefill for the goal 04 ticket. */
  prefill?: Record<string, unknown>;
  summary?: Record<string, unknown>;
}

export interface EngineHooks {
  onText?: (delta: string) => void;
  onToolCall?: (record: ToolCallRecord) => void | Promise<void>;
}

export interface EngineOptions {
  provider: AiProvider;
  backend: ToolBackend;
  maxTokens: number;
  maxToolRounds: number;
  hooks?: EngineHooks;
}

export interface EngineResult {
  text: string;
  rawText: string;
  flags: GuardFlags;
  toolCalls: ToolCallRecord[];
  drafts: DraftRef[];
  usage: ProviderUsage;
  promptHash: string;
  rounds: number;
  stopReason: string | null;
  /** The first request exactly as sent (for audits of prompt integrity and the eval graders). */
  request: ProviderRequest;
}

/** Hash of what defines the answer: model, system, tools and the first user turn (grounding included). */
export function promptHashOf(modelId: string, req: ProviderRequest): string {
  return hashOf({
    model: modelId,
    system: req.system,
    tools: req.tools.map((t) => ({ name: t.name, schema: t.input_schema })),
    messages: req.messages,
  });
}

export function buildRequest(ask: AiAsk, maxTokens: number): ProviderRequest {
  return {
    system: systemPrompt(ask.mode),
    tools: toolsFor(ask.user, ask.mode),
    messages: [{ role: 'user', content: userTurn(ask) }],
    maxTokens,
  };
}

function textOf(content: Anthropic.ContentBlockParam[]): string {
  return content
    .filter((b): b is Anthropic.TextBlockParam => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

function draftFrom(record: ToolCallRecord): DraftRef | null {
  if (record.outcome !== 'ok' || record.kind !== 'draft') return null;
  const o = record.output as
    | { draftId?: string; prefill?: Record<string, unknown>; summary?: Record<string, unknown> }
    | undefined;
  if (!o?.draftId) return null;
  return {
    kind: record.name === 'create_order_draft' ? 'order' : 'strategy',
    id: o.draftId,
    prefill: o.prefill,
    summary: o.summary,
  };
}

export async function runCopilot(ask: AiAsk, opts: EngineOptions): Promise<EngineResult> {
  const first = buildRequest(ask, opts.maxTokens);
  const promptHash = promptHashOf(opts.provider.modelId, first);
  const messages: Anthropic.MessageParam[] = [...first.messages];
  const ctx: ToolCallCtx = {
    user: ask.user,
    mode: ask.mode,
    surface: ask.surface,
    modelId: opts.provider.modelId,
    promptHash,
  };
  const usage: ProviderUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const toolCalls: ToolCallRecord[] = [];
  let rawText = '';
  let stopReason: string | null = null;
  let rounds = 0;

  for (;;) {
    rounds += 1;
    const turn = await opts.provider.complete({ ...first, messages }, opts.hooks?.onText);
    usage.inputTokens += turn.usage.inputTokens;
    usage.outputTokens += turn.usage.outputTokens;
    usage.cacheReadTokens += turn.usage.cacheReadTokens;
    usage.cacheWriteTokens += turn.usage.cacheWriteTokens;
    stopReason = turn.stopReason;

    if (turn.stopReason === 'refusal') {
      rawText = 'The AI service declined to answer this request.';
      break;
    }
    const uses = turn.content.filter(
      (b): b is Anthropic.ToolUseBlockParam => b.type === 'tool_use',
    );
    if (turn.stopReason !== 'tool_use' || uses.length === 0) {
      rawText = textOf(turn.content);
      break;
    }
    if (rounds > opts.maxToolRounds) {
      rawText =
        'I could not finish within the allowed number of data lookups. Try a narrower question.';
      break;
    }
    messages.push({ role: 'assistant', content: turn.content });
    const results = await Promise.all(
      uses.map((u) => dispatchTool({ id: u.id, name: u.name, input: u.input }, ctx, opts.backend)),
    );
    for (const r of results) {
      toolCalls.push(r.record);
      await opts.hooks?.onToolCall?.(r.record);
    }
    // All results of one assistant turn go back in a single user message.
    messages.push({ role: 'user', content: results.map((r) => r.block) });
  }

  const sources: unknown[] = [
    ask.grounding ?? {},
    ask.context,
    ask.message,
    ...toolCalls.filter((t) => t.outcome === 'ok').map((t) => t.output),
  ];
  const guarded = applyGuards({ text: rawText, mode: ask.mode, sources });
  return {
    text: guarded.text,
    rawText,
    flags: guarded.flags,
    toolCalls,
    drafts: toolCalls.map(draftFrom).filter((d): d is DraftRef => d !== null),
    usage,
    promptHash,
    rounds,
    stopReason,
    request: first,
  };
}
