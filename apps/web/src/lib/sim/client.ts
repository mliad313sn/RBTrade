import { KoraApiError } from '@kora/sdk';

import { api } from '../api-browser';
import type { PaperProjectRequest, ProjectRequest } from './types';

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

/** Maps SDK errors to the simulator's plain-language error (validation issues joined). */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof KoraApiError) {
      const issues =
        ((e.body ?? {}) as { issues?: { path: string; message: string }[] }).issues ?? [];
      const message = issues.length ? issues.map((i) => i.message).join(' ') : e.message;
      throw new SimApiError(e.status, e.code, message, issues);
    }
    throw e;
  }
}

/** Browser client for the /sim routes, on the typed SDK (B-506). */
export const simApi = {
  project: (req: ProjectRequest) => call(() => api.simProject(req)),
  paperProject: (req: PaperProjectRequest) => call(() => api.simPaperProject(req)),
  /** Block bootstrap of a trade list (goal 06 backtests send their OOS R multiples here, B-502). */
  fromTrades: (req: Record<string, unknown>) => call(() => api.simFromTrades(req)),
  /** B-505: saved scenarios. */
  scenarios: (kind: 'practice' | 'pro') => call(() => api.simScenarios(kind)),
  saveScenario: (body: {
    kind: 'practice' | 'pro';
    name: string;
    input: Record<string, unknown>;
    overwrite?: boolean;
  }) => call(() => api.saveSimScenario(body)),
  deleteScenario: (id: string) => call(() => api.deleteSimScenario(id)),
};
