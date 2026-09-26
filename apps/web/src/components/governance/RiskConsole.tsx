'use client';

import { KILL_SWITCH_SCOPE_LABELS, KILL_SWITCH_SCOPES, type KillSwitchScope } from '@kora/domain';
import { MarketDataSocket } from '@kora/sdk';
import { Banner, Button, Chip, Dialog, HoldToConfirmButton, Panel, Select, Table, useToast, type Column } from '@kora/ui';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useShell } from '@/components/shell/ShellContext';
import { GovernanceApiError, governanceApi, type AlertView, type ExposureRow, type FourEyesView, type Overview, type RobotUsage } from '@/lib/governance/client';

import { EvidenceExport } from './EvidenceExport';

const short = (id: string | null | undefined) => (id ? `${id.slice(0, 8)}…` : '—');
const time = (iso: string) => iso.replace('T', ' ').slice(0, 19);
const tone = (s: AlertView['severity']) => (s === 'critical' ? 'live' : s === 'warning' ? 'warn' : 'neutral');
const KIND_LABEL: Record<FourEyesView['kind'], string> = {
  limit_override: 'Loosen limit',
  kill_switch_resume: 'Resume after firm halt',
  mfa_reset: 'MFA reset',
  disclosure_publish: 'Publish disclosure',
};

const exposureCols: Column<ExposureRow>[] = [
  { key: 'acct', header: 'Account', width: '104px', cell: (r) => <span className="k-num" title={r.accountId}>{short(r.accountId)}</span> },
  { key: 'eq', header: 'Equity', numeric: true, cell: (r) => `${r.equity} ${r.baseCurrency}` },
  { key: 'gross', header: 'Gross exposure', numeric: true, cell: (r) => r.grossExposure },
  { key: 'lev', header: 'Leverage', numeric: true, width: '80px', cell: (r) => `${r.leverage}× / ${r.limits.maxLeverage}×` },
  { key: 'day', header: 'Day P&L', numeric: true, cell: (r) => r.dayPnl },
  { key: 'dayu', header: 'Day loss vs limit', numeric: true, cell: (r) => `${r.utilisation.dailyLossPct}% of ${r.limits.dailyLossLimit}` },
  { key: 'weeku', header: 'Week loss', numeric: true, width: '90px', cell: (r) => `${r.utilisation.weeklyLossPct}%` },
  {
    key: 'state',
    header: 'State',
    width: '150px',
    cell: (r) => (
      <span className="flex gap-1">
        {r.nearLimit ? <Chip tone="warn">Near limit</Chip> : null}
        {r.halted ? <Chip tone="live">Halted</Chip> : null}
        {Object.keys(r.limitOverrides).length ? <Chip tone="ai">Override</Chip> : null}
      </span>
    ),
  },
];

const robotCols: Column<RobotUsage>[] = [
  { key: 'name', header: 'Robot', cell: (r) => r.name },
  { key: 'owner', header: 'Owner', width: '104px', cell: (r) => short(r.ownerId) },
  { key: 'd', header: 'Day loss', numeric: true, width: '90px', cell: (r) => `${r.usage.dailyLossPct}%` },
  { key: 'w', header: 'Week loss', numeric: true, width: '90px', cell: (r) => `${r.usage.weeklyLossPct}%` },
  { key: 'dd', header: 'Drawdown', numeric: true, width: '90px', cell: (r) => `${r.usage.drawdownPct}%` },
  { key: 'near', header: '', width: '110px', cell: (r) => (r.nearAutoPause ? <Chip tone="warn">Near auto-pause</Chip> : null) },
];

/**
 * Risk officer console (goal 09, 2nd line). Real goal 03/06 data from `/risk-console/overview`
 * (refreshed every 5 s as the fallback) plus live alerts on the WS channel `risk:alerts`.
 */
export function RiskConsole({ wsPort }: { wsPort: string }) {
  const { me } = useShell();
  const toast = useToast();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<Array<AlertView & { receivedAt: string }>>([]);
  const [socketState, setSocketState] = useState('connecting');
  const [decision, setDecision] = useState<{ req: FourEyesView; action: 'approve' | 'reject' } | null>(null);
  const [note, setNote] = useState('');
  const [scope, setScope] = useState<KillSwitchScope>('robots_cancel');
  const [ksReason, setKsReason] = useState('');
  const socket = useRef<MarketDataSocket | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await governanceApi.overview());
      setError(null);
    } catch (e) {
      setError(e instanceof GovernanceApiError ? e.message : 'Could not load the console.');
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const s = new MarketDataSocket({ url: `${proto}://${window.location.hostname}:${wsPort}/ws` });
    socket.current = s;
    s.onState(setSocketState);
    s.riskAlerts<AlertView>((msg) => {
      setLive((prev) => (prev.some((a) => a.id === msg.alert.id) ? prev : [{ ...msg.alert, receivedAt: new Date().toISOString() }, ...prev].slice(0, 100)));
    });
    s.connect();
    return () => s.close();
  }, [wsPort]);

  const alerts: Array<AlertView & { receivedAt?: string }> = [...live];
  for (const a of data?.alerts ?? []) if (!alerts.some((x) => x.id === a.id)) alerts.push(a);
  alerts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const ack = async (a: AlertView) => {
    try {
      await governanceApi.acknowledge(a.id);
      setLive((prev) => prev.map((x) => (x.id === a.id ? { ...x, acknowledgedAt: new Date().toISOString(), acknowledgedBy: me.user.id } : x)));
      void load();
    } catch (e) {
      toast.push(e instanceof Error ? e.message : 'Could not acknowledge.', 'critical');
    }
  };

  const logIncident = async (a: AlertView) => {
    const category = a.kind.startsWith('reconciliation.') ? 'reconciliation_break' : a.kind.startsWith('kill_switch.') ? 'kill_switch_fired' : 'other';
    try {
      const inc = await governanceApi.logIncident({ title: `${a.kind}: ${a.message}`.slice(0, 160), description: a.message, category, alertId: a.id });
      toast.push(`Incident ${inc.ref} logged from the alert. Classify it next (impact × urgency).`, 'success', 8000);
      void load();
    } catch (e) {
      toast.push(e instanceof Error ? e.message : 'Could not log the incident.', 'critical');
    }
  };

  const decide = async () => {
    if (!decision) return;
    try {
      await (decision.action === 'approve' ? governanceApi.approve(decision.req.id, note.trim()) : governanceApi.reject(decision.req.id, note.trim()));
      toast.push(decision.action === 'approve' ? 'Approved and applied. Both names are in the audit log.' : 'Rejected.', 'success');
      setDecision(null);
      setNote('');
      void load();
    } catch (e) {
      toast.push(e instanceof Error ? e.message : 'Could not decide.', 'critical');
    }
  };

  const killAll = async () => {
    try {
      const r = await governanceApi.globalKillSwitch(scope, ksReason.trim());
      toast.push(`Firm-wide kill switch: ${r.accounts} accounts halted, ${r.ordersCancelled} orders cancelled, ${r.positionsFlattened} positions flattened in ${r.durationMs} ms. Resuming needs four eyes.`, 'success', 10000);
      setKsReason('');
      void load();
    } catch (e) {
      toast.push(e instanceof Error ? e.message : 'Kill switch failed.', 'critical');
    }
  };

  return (
    <div className="grid gap-3 p-3" data-testid="risk-console">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold m-0">Risk console</h1>
        <Chip tone="paper">PAPER</Chip>
        <Chip>2nd line</Chip>
        <Chip tone={socketState === 'open' ? 'ai' : 'warn'} data-testid="risk-live-state">
          {socketState === 'open' ? 'Live alerts on' : `Live alerts ${socketState}`}
        </Chip>
        <span className="text-xs text-muted ml-auto">SIMULATED data · as of {data ? time(data.asOf) : '…'} UTC</span>
      </header>
      {error ? <Banner tone="critical">{error}</Banner> : null}

      <div className="grid gap-3 xl:grid-cols-[3fr_2fr]">
        <Panel title={`Alerts (${alerts.filter((a) => !a.acknowledgedAt).length} open)`} data-testid="risk-alerts">
          <ul className="list-none m-0 p-0 grid gap-1 max-h-80 overflow-auto" aria-live="polite">
            {alerts.slice(0, 50).map((a) => (
              <li key={a.id} className="flex items-start gap-2 text-sm border-b border-border py-1" data-testid="risk-alert" data-kind={a.kind}>
                <Chip tone={tone(a.severity)}>{a.severity}</Chip>
                <span className="flex-1">
                  <span className="k-num text-xs text-muted">{time(a.createdAt)}</span> <strong>{a.kind}</strong> · {a.message}
                  {a.accountId ? <span className="text-xs text-muted"> · account {short(a.accountId)}</span> : null}
                  {a.receivedAt ? <span className="text-xs text-muted"> · live</span> : null}
                </span>
                {a.severity === 'critical' ? (
                  <Button size="sm" variant="ghost" onClick={() => void logIncident(a)} data-testid="log-incident">
                    Log incident
                  </Button>
                ) : null}
                {a.acknowledgedAt ? (
                  <span className="text-xs text-muted">acknowledged</span>
                ) : (
                  <Button size="sm" onClick={() => void ack(a)} data-testid="ack-alert">
                    Acknowledge
                  </Button>
                )}
              </li>
            ))}
            {alerts.length === 0 ? <li className="text-sm text-muted">No alerts.</li> : null}
          </ul>
        </Panel>

        <Panel title="Firm-wide kill switch" data-testid="global-kill-switch">
          <p className="text-sm m-0 mb-2">
            Halts every active account. Each account then needs a second authorised person to resume (four-eyes).
          </p>
          <div className="grid gap-2">
            <Select label="Scope" value={scope} onChange={(e) => setScope(e.target.value as KillSwitchScope)} options={KILL_SWITCH_SCOPES.map((s) => ({ value: s, label: KILL_SWITCH_SCOPE_LABELS[s].title }))} />
            <label className="grid gap-1 text-sm">
              <span className="k-label">Reason (audited)</span>
              <input className="k-input" value={ksReason} onChange={(e) => setKsReason(e.target.value)} maxLength={500} data-testid="global-ks-reason" />
            </label>
            <HoldToConfirmButton variant="danger-solid" holdMs={1500} disabled={ksReason.trim().length < 3} onConfirm={() => void killAll()} data-testid="global-ks-hold">
              Hold to halt all accounts
            </HoldToConfirmButton>
          </div>
        </Panel>
      </div>

      <Panel title="Firm exposure and loss vs limits" data-testid="risk-exposure">
        <div className="flex flex-wrap gap-3 text-sm mb-2">
          {(data?.exposure.firm ?? []).map((f) => (
            <span key={f.currency} className="k-num">
              {f.currency}: {f.accounts} accounts · equity {f.equity} · gross {f.grossExposure} · day P&amp;L {f.dayPnl}
            </span>
          ))}
        </div>
        <Table label="Accounts by limit utilisation" columns={exposureCols} rows={data?.exposure.accounts ?? []} rowKey={(r) => r.accountId} height={220} empty="No active accounts" />
        <p className="text-xs text-muted mt-1">Near limit at {data?.exposure.nearLimitPct ?? 80}% of a loss limit or the leverage cap (placeholder threshold).</p>
      </Panel>

      <div className="grid gap-3 xl:grid-cols-2">
        <Panel title="Pending four-eyes approvals" data-testid="risk-approvals">
          <ul className="list-none m-0 p-0 grid gap-2">
            {(data?.approvals.fourEyes ?? []).map((r) => {
              const mine = r.requestedBy === me.user.id;
              return (
                <li key={r.id} className="text-sm border-b border-border pb-2" data-testid="approval-row">
                  <div className="flex items-center gap-2">
                    <strong>{KIND_LABEL[r.kind]}</strong>
                    <span className="text-xs text-muted">
                      {r.subjectType} {short(r.subjectId)} · requested by {mine ? 'you' : short(r.requestedBy)} · {time(r.requestedAt)}
                    </span>
                  </div>
                  <p className="m-0">{r.reason}</p>
                  {r.kind === 'limit_override' ? <p className="m-0 text-xs k-num">{JSON.stringify(r.payload.limits)}</p> : null}
                  {mine ? (
                    <p className="m-0 text-xs text-muted" data-testid="approval-own">Your request: another authorised person must decide it.</p>
                  ) : (
                    <div className="flex gap-2 mt-1">
                      <Button size="sm" variant="primary" onClick={() => setDecision({ req: r, action: 'approve' })} data-testid="approve">
                        Approve
                      </Button>
                      <Button size="sm" onClick={() => setDecision({ req: r, action: 'reject' })} data-testid="reject">
                        Reject
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
            {(data?.approvals.robotSignoffs ?? []).map((s) => (
              <li key={s.robotId} className="text-sm">
                <strong>Robot risk sign-off</strong> · {s.name} (owner {short(s.ownerId)}) asked for promotion {time(s.requestedAt)}
              </li>
            ))}
            {!data?.approvals.fourEyes.length && !data?.approvals.robotSignoffs.length ? <li className="text-sm text-muted">Nothing waiting.</li> : null}
          </ul>
        </Panel>

        <Panel title="Limit breaches (latest)" data-testid="risk-breaches">
          <ul className="list-none m-0 p-0 grid gap-1 max-h-60 overflow-auto">
            {(data?.limitBreaches ?? []).slice(0, 20).map((b) => (
              <li key={b.id} className="text-sm">
                <span className="k-num text-xs text-muted">{time(b.createdAt)}</span> {b.message}
              </li>
            ))}
            {!data?.limitBreaches.length ? <li className="text-sm text-muted">No breaches.</li> : null}
          </ul>
        </Panel>

        <Panel title="Robots near auto-pause" data-testid="risk-robots">
          <Table label="Running robots" columns={robotCols} rows={data?.robots.robots ?? []} rowKey={(r) => r.robotId} height={160} empty="No running robots" />
        </Panel>

        <Panel title="Kill-switch history" data-testid="risk-killswitch">
          <ul className="list-none m-0 p-0 grid gap-1 max-h-60 overflow-auto">
            {(data?.killSwitch ?? []).map((k) => (
              <li key={k.auditId} className="text-sm">
                <span className="k-num text-xs text-muted">{time(k.ts)}</span> {k.action}
                {k.scope ? ` · ${k.scope}` : ''}
                {k.firm ? ' · firm' : ''}
                {k.durationMs !== null ? ` · ${k.durationMs} ms` : ''}
                {k.accountId ? ` · account ${short(k.accountId)}` : ''}
              </li>
            ))}
            {!data?.killSwitch.length ? <li className="text-sm text-muted">No kill-switch activity.</li> : null}
          </ul>
        </Panel>

        <Panel title="Reconciliation" data-testid="risk-reconciliation">
          <p className="text-sm m-0">
            Last run: {data?.reconciliation.lastRun ? `${time(data.reconciliation.lastRun.startedAt)} · ${data.reconciliation.lastRun.accountsChecked} accounts · ${data.reconciliation.lastRun.mismatches} mismatches` : 'none yet'}
          </p>
          <ul className="list-none m-0 p-0 grid gap-1">
            {(data?.reconciliation.breaks ?? []).map((b) => (
              <li key={b.id} className="text-sm" data-testid="recon-break">
                <Chip tone="live">Break</Chip> {time(b.startedAt)} · {b.mismatches} mismatch(es) over {b.accountsChecked} accounts
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title={`AI suggestions (last ${data?.ai.days ?? 7} days)`} data-testid="risk-ai">
          <p className="text-sm m-0 k-num">
            {data ? `${data.ai.drafts} drafts · ${data.ai.accepted} accepted · ${data.ai.rejected} rejected · ${data.ai.undecided} undecided · acceptance ${data.ai.acceptanceRatePct ?? '—'}% · ${data.ai.requests} requests` : '…'}
          </p>
          <p className="text-xs text-muted m-0 mt-1">The copilot only drafts; a person accepts or rejects every draft.</p>
        </Panel>

        <Panel title={`Novice guardrails (last ${data?.noviceGuardrails.days ?? 7} days)`} data-testid="risk-novice">
          <ul className="list-none m-0 p-0 grid gap-1 text-sm">
            {(data?.noviceGuardrails.rejections ?? []).map((r) => (
              <li key={r.code}>
                {r.code}: {r.events} blocked order(s) on {r.accounts} account(s)
              </li>
            ))}
            <li>{data?.noviceGuardrails.looseningRequests.length ?? 0} loosening / borrowing request(s) waiting their delay</li>
            {(data?.noviceGuardrails.repeatedCoolingOff ?? []).map((r) => (
              <li key={r.accountId}>
                <Chip tone="warn">Pattern</Chip> account {short(r.accountId)} cooled off on {r.days} days this month
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Open incidents" data-testid="risk-incidents">
          <ul className="list-none m-0 p-0 grid gap-1 text-sm">
            {(data?.openIncidents ?? []).map((i) => (
              <li key={i.id}>
                {i.ref} · {i.priority ?? 'unclassified'} · {i.status} · {i.title}
                {i.exercise ? ' (exercise)' : ''}
              </li>
            ))}
            {!data?.openIncidents.length ? <li className="text-muted">No open incidents.</li> : null}
          </ul>
        </Panel>
      </div>

      <EvidenceExport />

      <Dialog
        open={!!decision}
        onOpenChange={(o) => (o ? undefined : setDecision(null))}
        title={decision?.action === 'approve' ? 'Approve request' : 'Reject request'}
        description="Four-eyes: your decision and note are recorded with the requester's name in the audit log."
      >
        <label className="k-label block mb-1" htmlFor="decision-note">
          Note
        </label>
        <textarea id="decision-note" className="k-input w-full min-h-20" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} data-testid="decision-note" />
        <div className="k-dialog__actions">
          <Button onClick={() => setDecision(null)}>Cancel</Button>
          <Button variant="primary" disabled={note.trim().length < 3} onClick={() => void decide()} data-testid="confirm-decision">
            {decision?.action === 'approve' ? 'Approve' : 'Reject'}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
