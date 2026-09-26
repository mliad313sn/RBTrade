import { afterEach, describe, expect, it, vi } from 'vitest';

import { streamAnswer } from './client';

function sseResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

describe('copilot SSE client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('streams deltas (even split across chunks) and resolves the final answer', async () => {
    const final = {
      status: 'ok',
      answer: 'EURUSD bid 1.08419.\n\nNot investment advice.',
      flags: {},
      drafts: [],
      toolCalls: [],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'event: delta\ndata: {"type":"delta","text":"EURUSD "}\n\nevent: tool\ndata: {"type":"tool","name":"get_quote","outcome":"ok"}\n\nevent: del',
          'ta\ndata: {"type":"delta","text":"bid 1.08419."}\n\n',
          `event: final\ndata: ${JSON.stringify(final)}\n\n`,
        ]),
      ),
    );
    const deltas: string[] = [];
    const a = await streamAnswer('/ai/chat', { message: 'q' }, (d) => deltas.push(d));
    expect(deltas.join('')).toBe('EURUSD bid 1.08419.');
    expect(a).toMatchObject({ status: 'ok', answer: final.answer });
    const [url, init] = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]!;
    expect(url).toBe('/api/ai/chat');
    expect((init.headers as Record<string, string>).accept).toBe('text/event-stream');
    expect((init.headers as Record<string, string>)['x-kora-csrf']).toBe('1');
  });

  it('falls back to JSON and reports friendly states', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          status: 'budget_exceeded',
          message: "You've used today's copilot allowance.",
        }),
      ),
    );
    const a = await streamAnswer('/ai/chat', {}, () => undefined);
    expect(a).toEqual({
      status: 'budget_exceeded',
      message: "You've used today's copilot allowance.",
    });
  });
});
