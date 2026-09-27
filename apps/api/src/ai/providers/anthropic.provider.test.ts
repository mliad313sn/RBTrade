import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import { loadAiConfig } from '../core/config';
import type { ProviderRequest } from '../core/types';
import { AnthropicProvider, friendlyProviderError } from './anthropic.provider';

/**
 * IRTC R6-06: the production provider through the real SDK, with the HTTP transport replaced by an
 * in-memory `fetch` (no network, no key). Every request body is captured, and the answer is a
 * streamed server-sent-events body in the Messages API wire format.
 */

// A placeholder id: the model always comes from KORA_AI_MODEL (never a real model name here).
const MODEL = 'kora-test-model';

type Captured = { url: string; body: Record<string, unknown>; headers: Headers };

function sse(events: Array<Record<string, unknown>>): string {
  return events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

function transport(
  responder: (c: Captured) => { status: number; body: string; contentType?: string },
) {
  const calls: Captured[] = [];
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const c: Captured = {
      url: String(input instanceof Request ? input.url : input),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      headers: new Headers(init?.headers),
    };
    calls.push(c);
    const r = responder(c);
    return new Response(r.body, {
      status: r.status,
      headers: { 'content-type': r.contentType ?? 'text/event-stream', 'request-id': 'req_test' },
    });
  };
  return { calls, fetchImpl };
}

function client(fetchImpl: typeof fetch, maxRetries = 0): Anthropic {
  return new Anthropic({
    apiKey: 'test-key-not-real',
    baseURL: 'http://anthropic.test',
    fetch: fetchImpl,
    maxRetries,
  });
}

const toolUseStream = sse([
  {
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: MODEL,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 120,
        output_tokens: 1,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 7,
      },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking ' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'the quote.' } },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_quote', input: {} },
  },
  {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"symbol":' },
  },
  {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '"BTCUSD"}' },
  },
  { type: 'content_block_stop', index: 1 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: 42 },
  },
  { type: 'message_stop' },
]);

const request: ProviderRequest = {
  system: 'You are the KORA copilot.',
  maxTokens: 2048,
  messages: [{ role: 'user', content: 'What is the BTCUSD price?' }],
  tools: [
    {
      name: 'get_quote',
      description: 'Last quote',
      input_schema: {
        type: 'object',
        properties: { symbol: { type: 'string' } },
        required: ['symbol'],
      },
    },
    {
      name: 'get_candles',
      description: 'Candles',
      input_schema: { type: 'object', properties: {} },
    },
  ],
};

const cfg = (extra: Record<string, string> = {}) =>
  loadAiConfig({
    KORA_ENV: 'test',
    KORA_AI_PROVIDER: 'anthropic',
    KORA_AI_MODEL: MODEL,
    ANTHROPIC_API_KEY: 'k',
    ...extra,
  });

describe('AnthropicProvider through the SDK with a mocked transport (IRTC R6-06)', () => {
  it('refuses to construct without KORA_AI_MODEL (no default model id)', () => {
    expect(() => new AnthropicProvider(loadAiConfig({ KORA_ENV: 'test' }))).toThrow(
      /KORA_AI_MODEL/,
    );
  });

  it('streams a tool-use turn: request shape, caching marks, text deltas, content and usage', async () => {
    const t = transport(() => ({ status: 200, body: toolUseStream }));
    const p = new AnthropicProvider(cfg(), client(t.fetchImpl as typeof fetch));
    expect(p.modelId).toBe(MODEL);
    const deltas: string[] = [];
    const turn = await p.complete(request, (d) => deltas.push(d));

    expect(t.calls).toHaveLength(1);
    const { url, body, headers } = t.calls[0]!;
    expect(url).toBe('http://anthropic.test/v1/messages');
    expect(headers.get('x-api-key')).toBe('test-key-not-real');
    expect(body).toMatchObject({
      model: MODEL,
      max_tokens: 2048,
      stream: true,
      system: [
        { type: 'text', text: 'You are the KORA copilot.', cache_control: { type: 'ephemeral' } },
      ],
      tool_choice: { type: 'auto' },
      thinking: { type: 'adaptive' },
      messages: request.messages,
    });
    // Only the last tool carries the cache breakpoint (tools render before the system prompt).
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools.map((x) => x.name)).toEqual(['get_quote', 'get_candles']);
    expect(tools[0]!.cache_control).toBeUndefined();
    expect(tools[1]!.cache_control).toEqual({ type: 'ephemeral' });
    // No effort unless configured, and no structured-output format on a tool turn.
    expect(body.output_config).toBeUndefined();

    expect(deltas).toEqual(['Checking ', 'the quote.']);
    expect(turn.stopReason).toBe('tool_use');
    // The assistant turn goes back verbatim on the next round: text, then the parsed tool input.
    expect(turn.content).toHaveLength(2);
    expect(turn.content[0]).toMatchObject({ type: 'text', text: 'Checking the quote.' });
    expect(turn.content[1]).toMatchObject({ type: 'tool_use', id: 'toolu_1', name: 'get_quote' });
    expect((turn.content[1] as { input: unknown }).input).toEqual({ symbol: 'BTCUSD' });
    expect(turn.usage).toEqual({
      inputTokens: 120,
      outputTokens: 42,
      cacheReadTokens: 100,
      cacheWriteTokens: 7,
    });
  });

  it('structured output: format + effort in output_config, no tools, thinking omitted when configured', async () => {
    const t = transport(() => ({
      status: 200,
      body: sse([
        {
          type: 'message_start',
          message: {
            id: 'msg_2',
            type: 'message',
            role: 'assistant',
            model: MODEL,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 1 },
          },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '{"sentiment":0.2}' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 9 },
        },
        { type: 'message_stop' },
      ]),
    }));
    const p = new AnthropicProvider(
      cfg({ KORA_AI_EFFORT: 'low', KORA_AI_THINKING: 'omit' }),
      client(t.fetchImpl as typeof fetch),
    );
    const schema = {
      type: 'object',
      properties: { sentiment: { type: 'number' } },
      required: ['sentiment'],
      additionalProperties: false,
    };
    const turn = await p.complete({ ...request, outputFormat: { name: 'score', schema } });
    const body = t.calls[0]!.body;
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toEqual({ effort: 'low', format: { type: 'json_schema', schema } });
    expect(turn.stopReason).toBe('end_turn');
    expect(turn.content).toHaveLength(1);
    expect(turn.content[0]).toMatchObject({ type: 'text', text: '{"sentiment":0.2}' });
    // Absent cache counters read as 0.
    expect(turn.usage).toEqual({
      inputTokens: 5,
      outputTokens: 9,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it.each([
    [429, 'rate_limit_error', 'provider_rate_limited', true],
    [401, 'authentication_error', 'provider_auth', false],
    [403, 'permission_error', 'provider_auth', false],
    [400, 'invalid_request_error', 'provider_bad_request', false],
    [404, 'not_found_error', 'provider_bad_request', false],
    [500, 'api_error', 'provider_error', true],
  ] as const)(
    'an HTTP %i (%s) surfaces as a typed SDK error mapped to %s',
    async (status, type, code, retryable) => {
      const t = transport(() => ({
        status,
        body: JSON.stringify({ type: 'error', error: { type, message: 'nope' } }),
        contentType: 'application/json',
      }));
      const p = new AnthropicProvider(cfg(), client(t.fetchImpl as typeof fetch));
      const err = await p.complete(request).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Anthropic.APIError);
      expect(friendlyProviderError(err)).toMatchObject({ code, retryable });
      expect(t.calls).toHaveLength(1); // retries disabled in this client
    },
  );

  it('a transport failure maps to provider_unreachable; anything else to a generic, nothing-changed message', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const p = new AnthropicProvider(cfg(), client(failing));
    const err = await p.complete(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Anthropic.APIConnectionError);
    expect(friendlyProviderError(err)).toMatchObject({
      code: 'provider_unreachable',
      retryable: true,
    });
    expect(friendlyProviderError(new Error('boom'))).toEqual({
      code: 'copilot_error',
      message: 'The copilot could not answer this time. Nothing was changed.',
      retryable: true,
    });
  });

  it('retries a 529 overload with the SDK retry policy and then succeeds', async () => {
    let n = 0;
    const t = transport(() =>
      ++n === 1
        ? {
            status: 529,
            body: JSON.stringify({
              type: 'error',
              error: { type: 'overloaded_error', message: 'busy' },
            }),
            contentType: 'application/json',
          }
        : { status: 200, body: toolUseStream },
    );
    const p = new AnthropicProvider(cfg(), client(t.fetchImpl as typeof fetch, 1));
    const turn = await p.complete(request);
    expect(t.calls).toHaveLength(2);
    expect(turn.stopReason).toBe('tool_use');
  });
});
