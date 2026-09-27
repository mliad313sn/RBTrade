'use client';

import { Button, Dialog } from '@kora/ui';
import { useState } from 'react';

import { RobotsApiError, robotsApi } from '@/lib/robots/client';
import { auditTag, auditText } from '@/lib/robots/format';
import type { AuditItem, ChecklistView, RobotDetail } from '@/lib/robots/types';

const METERS: Array<{
  key: keyof RobotDetail['limitsUsage'];
  label: string;
  unit: (v: string) => string;
}> = [
  {
    key: 'dailyLoss',
    label: 'Daily loss',
    unit: (v) => `−${Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
  },
  {
    key: 'weeklyLoss',
    label: 'Weekly loss',
    unit: (v) => `−${Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
  },
  {
    key: 'maxDrawdownPct',
    label: 'Max drawdown (auto-pause)',
    unit: (v) => `−${Number(v).toFixed(1)}%`,
  },
  { key: 'ordersPerMinute', label: 'Orders / minute', unit: (v) => v },
  { key: 'grossExposure', label: 'Gross exposure', unit: (v) => `${Number(v).toFixed(1)}×` },
];

/** Per-robot risk-limit meters (used / limit). Text values carry the meaning; the bar is decoration. */
export function RiskMeters({ usage }: { usage: RobotDetail['limitsUsage'] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="risk-meters">
      {METERS.map((m) => {
        const u = usage[m.key];
        const ratio = Math.min(1, Math.max(0, Number(u.used) / (Number(u.limit) || 1)));
        const tone =
          ratio >= 0.8 ? 'var(--k-kill)' : ratio >= 0.5 ? 'var(--k-warn)' : 'var(--k-up)';
        return (
          <li key={m.key}>
            <div className="flex justify-between text-xs">
              <span className="text-muted">{m.label}</span>
              <span className="k-num">
                {m.unit(u.used)} / {m.unit(u.limit)}
              </span>
            </div>
            <div
              className="mt-1 h-1 rounded"
              style={{ background: 'var(--k-raised)' }}
              aria-hidden="true"
            >
              <div className="h-1 rounded" style={{ width: `${ratio * 100}%`, background: tone }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Live audit feed (hash-chained log) for the robot and its strategy. */
export function AuditFeed({ events }: { events: AuditItem[] }) {
  if (!events.length) return <p className="text-sm text-muted">No events yet.</p>;
  return (
    <ol className="m-0 flex list-none flex-col p-0 text-xs" data-testid="audit-feed">
      {events.map((e) => (
        <li
          key={e.id}
          className="grid grid-cols-[64px_72px_minmax(0,1fr)] gap-2 border-t py-1"
          style={{ borderColor: 'var(--k-border)' }}
        >
          <time className="k-num text-muted" dateTime={e.ts}>
            {e.ts.slice(11, 19)}
          </time>
          <span
            className="font-semibold"
            style={{
              color:
                auditTag(e.action) === 'SIGNAL'
                  ? 'var(--k-ai)'
                  : auditTag(e.action) === 'RISK'
                    ? 'var(--k-warn)'
                    : 'var(--k-accent)',
            }}
          >
            {auditTag(e.action)}
          </span>
          <span className="truncate" title={`${e.action} · #${e.id}`}>
            {auditText(e)}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Promote-to-LIVE checklist (goal 06 §9): evidence-backed items, then a TOTP confirmation. Blocked
 * while LIVE_TRADING_ENABLED=false, but the request is recorded and audited.
 */
export function PromotionChecklist({
  robotId,
  view,
  onChange,
}: {
  robotId: string;
  view: ChecklistView;
  onChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await robotsApi.promote(robotId, code);
    } catch (e) {
      setResult(e instanceof RobotsApiError ? e.message : 'The request failed.');
      if (e instanceof RobotsApiError && e.code !== 'mfa_failed') {
        setOpen(false);
        onChange();
      }
    } finally {
      setBusy(false);
      setCode('');
    }
  };
  return (
    <div className="flex flex-col gap-2" data-testid="promotion">
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {view.items.map((i) => (
          // IRTC R5-24: a status list, not read-only checkboxes that screen readers announce as operable.
          <li
            key={i.id}
            className="flex items-start gap-2 text-sm"
            data-testid={`check-${i.id}`}
            data-pass={i.pass ? 'true' : 'false'}
          >
            <span
              aria-hidden="true"
              className={`mt-0.5 w-4 text-center font-bold ${i.pass ? 'text-ok' : 'text-kill'}`}
            >
              {i.pass ? '✓' : '✗'}
            </span>
            <span>
              {i.label}
              <span className="ml-1 text-xs text-muted">
                {i.pass ? '✓ evidence on file' : '✗ missing'}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {view.blockedReason ? <p className="m-0 text-xs text-muted">{view.blockedReason}</p> : null}
      <Button
        variant="primary"
        onClick={() => setOpen(true)}
        disabled={!view.complete}
        data-testid="promote-open"
      >
        {view.complete ? 'Promote (2FA)' : 'Complete checklist to promote'}
      </Button>
      {result ? (
        <p className="m-0 text-xs" role="status" data-testid="promote-result">
          {result}
        </p>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Confirm with two-factor authentication"
        description="Promotion needs a fresh code from your authenticator app. Every request is recorded."
      >
        <label className="k-field">
          <span className="k-label">6-digit code</span>
          <input
            className="k-input k-num"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            data-testid="promote-code"
          />
        </label>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={code.length !== 6 || busy}
            onClick={() => void submit()}
            data-testid="promote-submit"
          >
            Request promotion
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
