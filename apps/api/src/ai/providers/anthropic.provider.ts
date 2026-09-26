import Anthropic from '@anthropic-ai/sdk';

import type { AiConfig } from '../core/config';
import type { AiProvider, ProviderRequest, ProviderTurn } from '../core/types';

/**
 * The real provider: the official Anthropic TypeScript SDK. The model id comes from `KORA_AI_MODEL`
 * only (the constructor refuses to run without it); credentials are resolved by the SDK from the
 * environment / secret store (`ANTHROPIC_API_KEY`).
 *
 * - Streaming (`messages.stream` + `finalMessage()`), text deltas forwarded to the caller.
 * - Prompt caching: the stable system prompt and the tool list are marked `cache_control` so repeat
 *   requests read them from the cache.
 * - Tools are strict (`strict: true`, schemas derived from zod); inputs are re-validated server side
 *   by the dispatcher anyway. Fine-grained (eager) tool-input streaming is left off: our tool inputs
 *   are a few ids, and keeping the API's own schema validation is worth more than earlier bytes.
 * - Thinking: adaptive by default (`KORA_AI_THINKING=omit` leaves the parameter out for models that
 *   do not take it); effort only when `KORA_AI_EFFORT` is set.
 */
export class AnthropicProvider implements AiProvider {
  readonly kind = 'anthropic' as const;
  readonly modelId: string;
  private readonly client: Anthropic;

  constructor(
    private readonly cfg: AiConfig,
    client?: Anthropic,
  ) {
    if (!cfg.model) throw new Error('KORA_AI_MODEL is not set');
    this.modelId = cfg.model;
    this.client = client ?? new Anthropic({ maxRetries: 2, timeout: 60_000 });
  }

  async complete(
    req: ProviderRequest,
    onTextDelta?: (delta: string) => void,
  ): Promise<ProviderTurn> {
    const tools: Anthropic.Tool[] = req.tools.map((t, i) =>
      i === req.tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t,
    );
    const params: Anthropic.MessageStreamParams = {
      model: this.modelId,
      max_tokens: req.maxTokens,
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      tools,
      tool_choice: { type: 'auto' },
      messages: req.messages,
      ...(this.cfg.thinking === 'adaptive' ? { thinking: { type: 'adaptive' as const } } : {}),
      ...(this.cfg.effort ? { output_config: { effort: this.cfg.effort } } : {}),
    };
    const stream = this.client.messages.stream(params);
    if (onTextDelta) stream.on('text', (delta) => onTextDelta(delta));
    const message = await stream.finalMessage();
    return {
      // The assistant turn goes back verbatim (thinking blocks included) on the next tool round.
      content: message.content as unknown as Anthropic.ContentBlockParam[],
      stopReason: message.stop_reason,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

/** Plain-language mapping of SDK errors (typed classes, most specific first). */
export function friendlyProviderError(err: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (err instanceof Anthropic.RateLimitError)
    return {
      code: 'provider_rate_limited',
      message: 'The AI service is busy right now. Please try again in a minute.',
      retryable: true,
    };
  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError
  )
    return {
      code: 'provider_auth',
      message: 'Copilot unavailable: the AI service rejected our credentials.',
      retryable: false,
    };
  if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError)
    return {
      code: 'provider_bad_request',
      message: 'Copilot unavailable: the AI service could not process this request.',
      retryable: false,
    };
  if (err instanceof Anthropic.APIConnectionError)
    return {
      code: 'provider_unreachable',
      message: 'The AI service is not reachable right now. Please try again shortly.',
      retryable: true,
    };
  if (err instanceof Anthropic.APIError)
    return {
      code: 'provider_error',
      message: 'The AI service had a problem. Please try again shortly.',
      retryable: true,
    };
  return {
    code: 'copilot_error',
    message: 'The copilot could not answer this time. Nothing was changed.',
    retryable: true,
  };
}
