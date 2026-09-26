import type { StrategyDefinition } from '@kora/domain';

import type {
  BacktestResult,
  ChecklistView,
  RobotDetail,
  RobotSummary,
  RunSummary,
  SensitivityResult,
  StrategyDetail,
  StrategySummary,
  ValidationResult,
  WalkForwardResult,
  AuditItem,
  SimProjection,
} from './types';

export class RobotsApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'RobotsApiError';
  }
}

async function call<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
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
  const data = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
  if (!res.ok) {
    const issues = (data.issues as Array<{ message: string }> | undefined) ?? [];
    const message = (data.message as string | undefined) ?? issues[0]?.message ?? res.statusText;
    throw new RobotsApiError(
      res.status,
      (data.error as string | undefined) ?? `http_${res.status}`,
      message,
      data,
    );
  }
  return data as T;
}

/** Browser client for the goal 06 endpoints (same-origin proxy, HttpOnly cookie, CSRF header). */
export const robotsApi = {
  strategies: () => call<{ strategies: StrategySummary[] }>('GET', '/strategies'),
  strategy: (id: string) => call<StrategyDetail>('GET', `/strategies/${id}`),
  validate: (definition: unknown) =>
    call<ValidationResult>('POST', '/strategies/validate', { definition }),
  createStrategy: (definition: StrategyDefinition, reason: string) =>
    call<StrategySummary & { created: boolean }>('POST', '/strategies', { definition, reason }),
  newVersion: (id: string, definition: StrategyDefinition, reason: string, baseVersionId: string) =>
    call<StrategySummary & { created: boolean }>('POST', `/strategies/${id}/versions`, {
      definition,
      reason,
      baseVersionId,
    }),
  backtest: (versionId: string, extra: Record<string, unknown> = {}) =>
    call<BacktestResult>('POST', '/backtests', { versionId, ...extra }),
  walkForward: (versionId: string, extra: Record<string, unknown> = {}) =>
    call<WalkForwardResult>('POST', '/backtests/walk-forward', {
      versionId,
      mode: 'anchored',
      folds: 4,
      ...extra,
    }),
  sensitivity: (
    versionId: string,
    x: { param: string; values: number[] },
    y: { param: string; values: number[] },
  ) => call<SensitivityResult>('POST', '/backtests/sensitivity', { versionId, x, y }),
  runs: (strategyId: string) =>
    call<{ runs: RunSummary[] }>('GET', `/backtests?strategyId=${strategyId}&limit=30`),
  run: (id: string) =>
    call<RunSummary & { result: Record<string, unknown> }>('GET', `/backtests/${id}`),
  runTrades: (id: string, segment: 'oos' | 'is' | 'wf' = 'oos') =>
    call<{
      trades: number[];
      source: 'backtest_in_sample' | 'backtest_out_of_sample';
      runId: string;
    }>('GET', `/backtests/${id}/trades?segment=${segment}`),
  robots: () => call<{ robots: RobotSummary[]; baseCurrency: string }>('GET', '/robots'),
  robot: (id: string) => call<RobotDetail>('GET', `/robots/${id}`),
  createRobot: (name: string, versionId: string) =>
    call<RobotDetail>('POST', '/robots', { name, versionId }),
  start: (id: string) => call<{ status: string }>('POST', `/robots/${id}/start`),
  pause: (id: string, reason: string) =>
    call<{ status: string }>('POST', `/robots/${id}/pause`, { reason }),
  switchVersion: (id: string, versionId: string, reason: string) =>
    call<{ version: number }>('PUT', `/robots/${id}/version`, { versionId, reason }),
  robotAudit: (id: string) => call<{ events: AuditItem[] }>('GET', `/robots/${id}/audit?limit=40`),
  promotion: (id: string) => call<ChecklistView>('GET', `/robots/${id}/promotion`),
  promote: (id: string, totpCode: string) =>
    call<never>('POST', `/robots/${id}/promote`, { totpCode }),
  strategyAudit: (strategyId: string) =>
    call<{ events: AuditItem[] }>('GET', `/audit?entity=strategy&entityId=${strategyId}&limit=40`),
  /** B-502: "Send to Monte Carlo" posts the OOS R multiples to the goal 05 simulator. */
  monteCarlo: (trades: number[], source: string, riskPct: number) =>
    call<SimProjection>('POST', '/sim/from-trades', {
      trades,
      source,
      riskPct,
      tradesPerPeriod: 20,
      horizonPeriods: 12,
      paths: 5000,
    }),
};
