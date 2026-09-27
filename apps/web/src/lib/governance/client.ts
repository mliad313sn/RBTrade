/**
 * Browser client for the goal 09 governance endpoints (same-origin /api proxy, HttpOnly cookie,
 * CSRF header). Types mirror the api responses the console and the internal audit view use.
 */

export class GovernanceApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GovernanceApiError';
  }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
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
    throw new GovernanceApiError(
      res.status,
      (data.error as string) ?? `http_${res.status}`,
      (data.message as string) ?? issues[0]?.message ?? res.statusText,
    );
  }
  return data as T;
}

export interface AlertView {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  kind: string;
  accountId: string | null;
  message: string;
  details: Record<string, unknown>;
  createdAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
}

export interface FourEyesView {
  id: string;
  kind: 'limit_override' | 'kill_switch_resume' | 'mfa_reset' | 'disclosure_publish' | 'role_grant';
  subjectType: string;
  subjectId: string;
  payload: Record<string, unknown>;
  reason: string;
  requestedBy: string;
  requestedAt: string;
  expiresAt: string;
  status: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
}

export interface ExposureRow {
  accountId: string;
  userId: string;
  baseCurrency: string;
  equity: string;
  grossExposure: string;
  leverage: string;
  dayPnl: string;
  weekPnl: string;
  openPositions: number;
  limits: {
    dailyLossLimit: string;
    weeklyLossLimit: string;
    maxLeverage: string;
    maxOrderNotional: string;
  };
  limitOverrides: Record<string, string>;
  utilisation: {
    dailyLossPct: string;
    weeklyLossPct: string;
    leveragePct: string;
    worstPct: string;
  };
  nearLimit: boolean;
  halted: boolean;
  haltScope: string | null;
  haltedBy: string | null;
}

export interface RobotUsage {
  robotId: string;
  name: string;
  ownerId: string;
  accountId: string;
  equity: string;
  usage: { dailyLossPct: string; weeklyLossPct: string; drawdownPct: string; worstPct: string };
  nearAutoPause: boolean;
  lastHeartbeatAt: string | null;
}

export interface Overview {
  asOf: string;
  environment: 'PAPER';
  simulated: true;
  exposure: {
    nearLimitPct: number;
    firm: Array<{
      currency: string;
      accounts: number;
      equity: string;
      grossExposure: string;
      dayPnl: string;
    }>;
    accounts: ExposureRow[];
  };
  limitBreaches: AlertView[];
  robots: { nearPausePct: number; robots: RobotUsage[] };
  approvals: {
    fourEyes: FourEyesView[];
    robotSignoffs: Array<{
      robotId: string;
      name: string;
      ownerId: string;
      requestedAt: string;
      review: string;
    }>;
  };
  killSwitch: Array<{
    auditId: string;
    ts: string;
    actorId: string;
    action: string;
    accountId: string | null;
    scope: string | null;
    reason: string | null;
    durationMs: number | null;
    firm: boolean;
    globalKillSwitchId: string | null;
  }>;
  reconciliation: {
    lastRun: {
      id: string;
      trigger: string;
      startedAt: string;
      accountsChecked: number;
      mismatches: number;
    } | null;
    breaks: Array<{
      id: string;
      trigger: string;
      startedAt: string;
      accountsChecked: number;
      mismatches: number;
    }>;
  };
  ai: {
    days: number;
    requests: number;
    drafts: number;
    accepted: number;
    rejected: number;
    undecided: number;
    acceptanceRatePct: string | null;
    rejectionRatePct: string | null;
  };
  noviceGuardrails: {
    days: number;
    rejections: Array<{ code: string; events: number; accounts: number }>;
    looseningRequests: Array<{
      auditId: string;
      ts: string;
      userId: string;
      accountId: string;
      pending: Record<string, { value: string; effectiveAt: string }>;
    }>;
    repeatedCoolingOff: Array<{ accountId: string; days: number }>;
  };
  alerts: AlertView[];
  openIncidents: Array<{
    id: string;
    ref: string;
    title: string;
    category: string;
    status: string;
    priority: string | null;
    exercise: boolean;
    detectedAt: string;
  }>;
}

export interface ControlSummary {
  id: string;
  area: string;
  areaLabel: string;
  title: string;
  cobit: string[];
  ownerLine: 1 | 2 | 3;
  frequency: string;
  evidence: { kind: string; source: string };
}

export interface AuditEventView {
  id: string;
  ts: string;
  actorId: string;
  actorType: string;
  action: string;
  entity: string;
  entityId: string | null;
  payload: Record<string, unknown>;
  hash: string;
}

export interface VerifyView {
  chain: {
    valid: boolean;
    count: number;
    firstBrokenId: string | null;
    reason: string | null;
    headHash: string;
  };
  anchors: {
    count: number;
    invalidSignatures: number;
    notMatchingChain: number;
    latest: AnchorView | null;
  };
  verifiedAt: string;
}

export interface AnchorView {
  id: string;
  headId: string;
  headHash: string;
  eventCount: number;
  anchoredAt: string;
  keyId: string;
  createdBy: string;
  signatureValid: boolean;
  matchesChain: boolean;
}

export interface SampleView {
  controlId: string;
  title: string;
  seed: string;
  requested: number;
  drawn: number;
  population: number;
  kind: 'audit_events' | 'evidence_rows';
  events?: AuditEventView[];
  columns?: string[];
  rows?: Array<Array<string | number | boolean | null>>;
}

export const governanceApi = {
  overview: () => call<Overview>('GET', '/risk-console/overview'),
  acknowledge: (id: string, note?: string) =>
    call<AlertView>('POST', `/risk-console/alerts/${id}/ack`, note ? { note } : {}),
  globalKillSwitch: (scope: string, reason: string) =>
    call<{
      accounts: number;
      ordersCancelled: number;
      positionsFlattened: number;
      durationMs: number;
    }>('POST', '/risk-console/kill-switch', { scope, reason }),
  approve: (id: string, note: string) =>
    call<FourEyesView>('POST', `/governance/approvals/${id}/approve`, { note }),
  reject: (id: string, note: string) =>
    call<FourEyesView>('POST', `/governance/approvals/${id}/reject`, { note }),
  controls: () => call<{ controls: ControlSummary[] }>('GET', '/governance/controls'),
  logIncident: (body: {
    title: string;
    description: string;
    category: string;
    alertId?: string;
    exercise?: boolean;
  }) => call<{ id: string; ref: string }>('POST', '/governance/incidents', body),
  events: (q: Record<string, string>) =>
    call<{ events: AuditEventView[]; nextBeforeId: string | null }>(
      'GET',
      `/internal-audit/events?${new URLSearchParams(q).toString()}`,
    ),
  verify: () => call<VerifyView>('GET', '/internal-audit/verify'),
  anchors: () => call<{ keyId: string; anchors: AnchorView[] }>('GET', '/internal-audit/anchors'),
  sample: (q: Record<string, string>) =>
    call<SampleView>('GET', `/internal-audit/sample?${new URLSearchParams(q).toString()}`),
};

/** Evidence download URL for a control and period (the browser sends the session cookie). */
export function evidenceUrl(
  controlId: string,
  format: 'csv' | 'pdf' | 'json',
  from?: string,
  to?: string,
): string {
  const q = new URLSearchParams({ format });
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  return `/api/governance/controls/${controlId}/evidence?${q.toString()}`;
}

/** yyyy-mm-dd date input value → ISO start of that UTC day. */
export function dayStartIso(day: string): string | undefined {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T00:00:00.000Z` : undefined;
}
