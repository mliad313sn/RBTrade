/**
 * Browser client for the goal 07 copilot endpoints (same-origin /api proxy, HttpOnly cookie, CSRF
 * header). Answers are always 200: `status` says ok / unavailable / budget_exceeded / rate_limited /
 * error, with a friendly `message` for anything but ok.
 */
export interface GuardFlags {
  ungrounded: string[];
  executionClaim: boolean;
  grade: number | null;
  suggestion: boolean;
  fallback: boolean;
}

export interface DraftRef {
  kind: 'order' | 'strategy';
  id: string;
  prefill?: Record<string, string>;
  summary?: { changes?: Array<{ param: string; from: number; to: number }> } & Record<
    string,
    unknown
  >;
}

export type AiAnswer =
  | {
      status: 'ok';
      answer: string;
      flags: GuardFlags;
      drafts: DraftRef[];
      toolCalls: Array<{ name: string; outcome: string }>;
      modelId: string;
      promptHash: string;
      cached: boolean;
      auditEventId: string;
      disclaimer: string;
    }
  | {
      status: 'unavailable' | 'budget_exceeded' | 'rate_limited' | 'error';
      message: string;
      retryAfterSeconds?: number;
    };

export interface AiContext {
  panel?: string;
  symbol?: string;
  timeframe?: string;
  robotId?: string;
  signalId?: string;
  strategyId?: string;
}

export interface BiasDriver {
  key: string;
  label: string;
  value: number;
  contribution: number;
}

export interface StripData {
  symbol: string;
  timeframe: string;
  bias: { direction: 'long' | 'short' | 'neutral'; label: string; score: number | null };
  confidence: { value: number; n: number; saidAs: number; bin: number } | null;
  reliabilityLine: string | null;
  edge: 'positive' | 'none' | 'insufficient_data';
  edgeStatement: string;
  calibration: {
    modelKey: string;
    n: number;
    hitRate: number | null;
    minN: number;
    source: string | null;
  };
  drivers: BiasDriver[];
  eventRisk: Array<{ time: string; currency: string; title: string; minutesAway: number }>;
  canDraft: boolean;
  disclaimer: string;
  method: string;
}

export interface CalibrationView {
  modelKey: string;
  n: number;
  hitRate: number | null;
  meanNetReturn: number | null;
  edge: 'positive' | 'none' | 'insufficient_data';
  edgeStatement: string;
  confidence: { value: number; n: number; saidAs: number } | null;
  reliabilityLine: string | null;
  minN: number;
}

export interface Suggestion {
  code: string;
  title: string;
  detail: string;
  draft: { kind: 'strategy'; param: string; from: number; to: number } | null;
}

export interface RobotInsights {
  robotId: string;
  name: string;
  strategyId: string;
  latestSignalId: string | null;
  calibration: CalibrationView;
  suggestions: Suggestion[];
  disclaimer: string;
}

export interface NoEdgeScan {
  robots: Array<{
    robotId: string;
    name: string;
    status: string;
    edge: string;
    n: number;
    statement: string;
    recommendation: string;
  }>;
  flagged: number;
}

export interface SignalFeatures {
  id: string;
  symbol: string;
  barTs: string;
  action: string;
  conditions: Array<{
    label: string;
    result: boolean | 'not_available';
    contribution: number | null;
    values: Record<string, number | null>;
    skipped?: boolean;
  }>;
  explanation?: string;
}

export class AiApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const HEADERS = { accept: 'application/json', 'x-kora-csrf': '1' };

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { ...HEADERS, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'include',
    cache: 'no-store',
  });
  const text = await res.text();
  const data = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
  if (!res.ok) throw new AiApiError(res.status, String(data.message ?? res.statusText));
  return data as T;
}

/**
 * POST with `Accept: text/event-stream`: calls `onDelta` for streamed text and resolves with the
 * final answer. Falls back to JSON if the server does not stream.
 */
export async function streamAnswer(
  path: string,
  body: unknown,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<AiAnswer> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { ...HEADERS, accept: 'text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include',
    cache: 'no-store',
    signal,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    throw new AiApiError(res.status, data.message ?? res.statusText);
  }
  if (!(res.headers.get('content-type') ?? '').includes('text/event-stream') || !res.body)
    return (await res.json()) as AiAnswer;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let final: AiAnswer | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!event || !data) continue;
      const parsed = JSON.parse(data) as Record<string, unknown>;
      if (event === 'delta') onDelta(String(parsed.text ?? ''));
      if (event === 'final') final = parsed as unknown as AiAnswer;
    }
  }
  return (
    final ?? {
      status: 'error',
      message: 'The copilot stopped before answering. Nothing was changed.',
    }
  );
}

export const aiApi = {
  status: () =>
    call<{
      available: boolean;
      message: string | null;
      usage: { userUsed: number; userBudget: number } | null;
      mode: 'pro' | 'novice';
    }>('GET', '/ai/status'),
  strip: (symbol: string, tf: string) =>
    call<StripData>(
      'GET',
      `/ai/strip?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(tf)}`,
    ),
  stripDraft: (symbol: string, timeframe: string) =>
    call<
      | {
          status: 'draft';
          draftId: string;
          prefill: Record<string, string>;
          preview: Record<string, unknown>;
        }
      | { status: 'no_draft'; message: string }
    >('POST', '/ai/strip/draft', { symbol, timeframe }),
  insights: (robotId: string) => call<RobotInsights>('GET', `/ai/robots/${robotId}/insights`),
  suggestionDraft: (robotId: string, body: { param: string; value: number; rationale: string }) =>
    call<{
      draftId: string;
      summary: { changes: Array<{ param: string; from: number; to: number }>; baseVersion: number };
    }>('POST', `/ai/robots/${robotId}/suggestions/draft`, body),
  scanNoEdge: () => call<NoEdgeScan>('GET', '/ai/scan/no-edge'),
  features: (signalId: string) => call<SignalFeatures>('GET', `/signals/${signalId}/features`),
  draft: (id: string) => call<Record<string, unknown>>('GET', `/ai/drafts/${id}`),
  decide: (
    id: string,
    body: { decision: 'accepted' | 'rejected'; orderId?: string; versionId?: string },
  ) => call<{ status: string }>('POST', `/ai/drafts/${id}/decision`, body),
  chat: (
    body: {
      message: string;
      context: AiContext;
      mode?: 'pro' | 'novice';
      surface?: 'chat' | 'robots';
    },
    onDelta: (t: string) => void,
    signal?: AbortSignal,
  ) => streamAnswer('/ai/chat', body, onDelta, signal),
  why: (signalId: string, onDelta: (t: string) => void, signal?: AbortSignal) =>
    streamAnswer(`/ai/signals/${signalId}/why`, {}, onDelta, signal),
  explain: (body: { topic: string; screenText?: string; question?: string; context?: AiContext }) =>
    call<AiAnswer>('POST', '/ai/explain', { ...body, context: body.context ?? {} }),
};
