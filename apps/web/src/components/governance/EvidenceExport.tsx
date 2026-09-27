'use client';

import { Banner, Panel, Select } from '@kora/ui';
import { useEffect, useMemo, useState } from 'react';

import {
  dayStartIso,
  evidenceUrl,
  governanceApi,
  type ControlSummary,
} from '@/lib/governance/client';

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const nextDay = (d: string) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * One-click evidence export (goal 09): any control of the matrix, any period, CSV or PDF. The api
 * runs the control's automated evidence query and audits the export with the file's SHA-256.
 */
export function EvidenceExport({ testId = 'evidence-export' }: { testId?: string }) {
  const [controls, setControls] = useState<ControlSummary[]>([]);
  const [controlId, setControlId] = useState('KC-15');
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(today());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    governanceApi
      .controls()
      .then((r) => setControls(r.controls))
      .catch(() => setError('Could not load the control matrix.'));
  }, []);

  const selected = controls.find((c) => c.id === controlId);
  // "To" is inclusive in the form (whole day), exclusive in the api.
  const range = useMemo(
    () => ({ from: dayStartIso(from), to: dayStartIso(nextDay(to)) }),
    [from, to],
  );
  const valid = !!range.from && !!range.to && range.from < range.to;

  return (
    <Panel title="Control evidence export" data-testid={testId}>
      {error ? <Banner tone="critical">{error}</Banner> : null}
      <div className="grid gap-2 md:grid-cols-[2fr_1fr_1fr_auto] items-end">
        <Select
          label="Control"
          value={controlId}
          onChange={(e) => setControlId(e.target.value)}
          options={(controls.length
            ? controls
            : [{ id: 'KC-15', title: 'Pre-trade risk limits' } as ControlSummary]
          ).map((c) => ({
            value: c.id,
            label: `${c.id} · ${c.title}`,
          }))}
          data-testid="evidence-control"
        />
        <label className="grid gap-1 text-sm">
          <span className="k-label">From (UTC)</span>
          <input
            className="k-input"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            data-testid="evidence-from"
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="k-label">To (UTC, inclusive)</span>
          <input
            className="k-input"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            data-testid="evidence-to"
          />
        </label>
        <div className="flex gap-2">
          <a
            className={`k-btn k-btn--primary k-btn--sm ${valid ? '' : 'pointer-events-none opacity-50'}`}
            href={valid ? evidenceUrl(controlId, 'csv', range.from, range.to) : undefined}
            aria-disabled={!valid}
            download
            data-testid="evidence-csv"
          >
            CSV
          </a>
          <a
            className={`k-btn k-btn--secondary k-btn--sm ${valid ? '' : 'pointer-events-none opacity-50'}`}
            href={valid ? evidenceUrl(controlId, 'pdf', range.from, range.to) : undefined}
            aria-disabled={!valid}
            download
            data-testid="evidence-pdf"
          >
            PDF
          </a>
        </div>
      </div>
      {selected ? (
        <p className="text-xs text-muted mt-2" data-testid="evidence-source">
          COBIT 2019 {selected.cobit.join(', ')} · line {selected.ownerLine} · {selected.frequency}{' '}
          · evidence: {selected.evidence.source}
        </p>
      ) : null}
    </Panel>
  );
}
