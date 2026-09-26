import type { PaperProjection, ProjectRequest, SimResult } from './types';

export class SimApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super(message);
    this.name = 'SimApiError';
  }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/sim${path}`, {
    method,
    headers: {
      accept: 'application/json',
      'x-kora-csrf': '1',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'include',
    cache: 'no-store',
  });
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const b = (data ?? {}) as {
      error?: string;
      message?: string;
      issues?: { path: string; message: string }[];
    };
    const issues = b.issues ?? [];
    const message = issues.length
      ? issues.map((i) => i.message).join(' ')
      : (b.message ?? res.statusText);
    throw new SimApiError(res.status, b.error ?? `http_${res.status}`, message, issues);
  }
  return data as T;
}

/** Browser client for the api /sim routes (same-origin proxy, HttpOnly cookie, CSRF header). */
export const simApi = {
  project: (req: ProjectRequest) => call<SimResult>('POST', '/project', req),
  paperProject: (req: {
    tradesPerPeriod: number;
    horizonPeriods: number;
    ruinFloorPct: number;
    seed: number;
    paths: number;
  }) => call<PaperProjection>('POST', '/paper/project', req),
  /** Block bootstrap of a trade list (goal 06 backtests send their OOS R multiples here, B-502). */
  fromTrades: (req: Record<string, unknown>) => call<SimResult>('POST', '/from-trades', req),
};
