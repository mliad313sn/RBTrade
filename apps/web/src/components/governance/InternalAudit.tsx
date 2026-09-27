'use client';

import { Banner, Button, Chip, Panel, Select, Table, type Column } from '@kora/ui';
import { useCallback, useEffect, useState } from 'react';

import {
  GovernanceApiError,
  governanceApi,
  type AnchorView,
  type AuditEventView,
  type ControlSummary,
  type SampleView,
  type VerifyView,
} from '@/lib/governance/client';

import { EvidenceExport } from './EvidenceExport';

const time = (iso: string) => iso.replace('T', ' ').slice(0, 19);

const eventCols: Column<AuditEventView>[] = [
  { key: 'id', header: '#', width: '72px', numeric: true, cell: (e) => e.id },
  {
    key: 'ts',
    header: 'Time (UTC)',
    width: '170px',
    cell: (e) => <span className="k-num">{time(e.ts)}</span>,
  },
  { key: 'action', header: 'Action', cell: (e) => e.action },
  {
    key: 'actor',
    header: 'Actor',
    width: '150px',
    cell: (e) => `${e.actorType} · ${e.actorId.slice(0, 8)}`,
  },
  {
    key: 'entity',
    header: 'Entity',
    cell: (e) => `${e.entity}${e.entityId ? ` · ${e.entityId.slice(0, 12)}` : ''}`,
  },
  {
    key: 'hash',
    header: 'Hash',
    width: '110px',
    cell: (e) => (
      <span className="k-num" title={e.hash}>
        {e.hash.slice(0, 10)}…
      </span>
    ),
  },
];

const anchorCols: Column<AnchorView>[] = [
  {
    key: 'at',
    header: 'Anchored (UTC)',
    width: '170px',
    cell: (a) => <span className="k-num">{time(a.anchoredAt)}</span>,
  },
  { key: 'head', header: 'Head id', numeric: true, width: '90px', cell: (a) => a.headId },
  {
    key: 'hash',
    header: 'Head hash',
    cell: (a) => (
      <span className="k-num" title={a.headHash}>
        {a.headHash.slice(0, 16)}…
      </span>
    ),
  },
  { key: 'key', header: 'Key', width: '140px', cell: (a) => a.keyId },
  {
    key: 'ok',
    header: 'Checks',
    width: '200px',
    cell: (a) => (
      <span className="flex gap-1">
        <Chip tone={a.signatureValid ? 'ai' : 'live'}>
          {a.signatureValid ? 'signature ok' : 'bad signature'}
        </Chip>
        <Chip tone={a.matchesChain ? 'ai' : 'live'}>
          {a.matchesChain ? 'in chain' : 'not in chain'}
        </Chip>
      </span>
    ),
  },
];

/**
 * Internal audit view (goal 09, 3rd line): read-only audit log, hash-chain and anchor verification,
 * reproducible sampling per control, CSV exports and the control evidence export.
 */
export function InternalAudit() {
  const [verify, setVerify] = useState<VerifyView | null>(null);
  const [anchors, setAnchors] = useState<AnchorView[]>([]);
  const [events, setEvents] = useState<AuditEventView[]>([]);
  const [action, setAction] = useState('');
  const [controls, setControls] = useState<ControlSummary[]>([]);
  const [controlId, setControlId] = useState('KC-06');
  const [n, setN] = useState('10');
  const [seed, setSeed] = useState('');
  const [sample, setSample] = useState<SampleView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadEvents = useCallback(async () => {
    try {
      const q: Record<string, string> = { limit: '200' };
      if (action.trim()) q.action = action.trim();
      setEvents((await governanceApi.events(q)).events);
      setError(null);
    } catch (e) {
      setError(e instanceof GovernanceApiError ? e.message : 'Could not load events.');
    }
  }, [action]);

  useEffect(() => {
    void loadEvents();
    governanceApi
      .anchors()
      .then((r) => setAnchors(r.anchors))
      .catch(() => undefined);
    governanceApi
      .controls()
      .then((r) => setControls(r.controls))
      .catch(() => undefined);
    // Filters apply on demand (button), not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runVerify = async () => {
    try {
      setVerify(await governanceApi.verify());
      setAnchors((await governanceApi.anchors()).anchors);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verification failed.');
    }
  };

  const draw = async () => {
    try {
      const q: Record<string, string> = { controlId, n };
      if (seed.trim()) q.seed = seed.trim();
      const s = await governanceApi.sample(q);
      setSample(s);
      setSeed(s.seed);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sampling failed.');
    }
  };

  const exportEventsUrl = `/api/internal-audit/events/export${action.trim() ? `?action=${encodeURIComponent(action.trim())}` : ''}`;
  const sampleCsvUrl = sample
    ? `/api/internal-audit/sample?${new URLSearchParams({ controlId: sample.controlId, n: String(sample.requested), seed: sample.seed, format: 'csv' }).toString()}`
    : undefined;

  return (
    <div className="grid gap-3 p-3" data-testid="internal-audit">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold m-0">Internal audit</h1>
        <Chip>3rd line</Chip>
        <Chip tone="paper">Read-only</Chip>
      </header>
      {error ? <Banner tone="critical">{error}</Banner> : null}

      <Panel
        title="Audit-log integrity"
        actions={
          <Button
            size="sm"
            variant="primary"
            onClick={() => void runVerify()}
            data-testid="ia-verify"
          >
            Verify chain and anchors
          </Button>
        }
      >
        {verify ? (
          <div data-testid="ia-verify-result">
            <Banner
              tone={
                verify.chain.valid &&
                !verify.anchors.invalidSignatures &&
                !verify.anchors.notMatchingChain
                  ? 'info'
                  : 'critical'
              }
              title={verify.chain.valid ? 'Chain valid.' : 'Chain broken.'}
            >
              {verify.chain.valid
                ? `${verify.chain.count} events recomputed; head ${verify.chain.headHash.slice(0, 16)}…`
                : `First broken event #${verify.chain.firstBrokenId} (${verify.chain.reason}).`}{' '}
              {verify.anchors.count} signed anchor(s): {verify.anchors.invalidSignatures} bad
              signature(s), {verify.anchors.notMatchingChain} not matching the chain.
            </Banner>
          </div>
        ) : (
          <p className="text-sm text-muted m-0">
            Recomputes every hash and checks each signed anchor against the chain. The run is
            recorded.
          </p>
        )}
        <Table
          label="Signed anchors"
          columns={anchorCols}
          rows={anchors}
          rowKey={(a) => a.id}
          height={140}
          empty="No anchors yet"
        />
      </Panel>

      <Panel
        title="Audit events"
        actions={
          <a
            className="k-btn k-btn--secondary k-btn--sm"
            href={exportEventsUrl}
            download
            data-testid="ia-events-csv"
          >
            Export CSV
          </a>
        }
      >
        <div className="flex gap-2 items-end mb-2">
          <label className="grid gap-1 text-sm">
            <span className="k-label">Action (exact or prefix.*)</span>
            <input
              className="k-input"
              value={action}
              onChange={(e) => setAction(e.target.value)}
              placeholder="e.g. kill_switch.*"
              data-testid="ia-action"
            />
          </label>
          <Button size="sm" onClick={() => void loadEvents()} data-testid="ia-filter">
            Filter
          </Button>
        </div>
        <Table
          label="Audit events"
          columns={eventCols}
          rows={events}
          rowKey={(e) => e.id}
          height={320}
          empty="No events"
        />
      </Panel>

      <Panel title="Sampling per control" data-testid="ia-sampling">
        <div className="grid gap-2 md:grid-cols-[2fr_80px_1fr_auto] items-end">
          <Select
            label="Control"
            value={controlId}
            onChange={(e) => setControlId(e.target.value)}
            options={(controls.length
              ? controls
              : [{ id: 'KC-06', title: 'Four-eyes on loosening limits' } as ControlSummary]
            ).map((c) => ({ value: c.id, label: `${c.id} · ${c.title}` }))}
            data-testid="ia-sample-control"
          />
          <label className="grid gap-1 text-sm">
            <span className="k-label">N</span>
            <input
              className="k-input"
              inputMode="numeric"
              value={n}
              onChange={(e) => setN(e.target.value.replace(/\D/g, '').slice(0, 3))}
              data-testid="ia-sample-n"
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="k-label">Seed (optional)</span>
            <input
              className="k-input"
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              data-testid="ia-sample-seed"
            />
          </label>
          <Button
            size="sm"
            variant="primary"
            disabled={!n}
            onClick={() => void draw()}
            data-testid="ia-sample-draw"
          >
            Draw sample
          </Button>
        </div>
        {sample ? (
          <div className="mt-2" data-testid="ia-sample-result">
            <p className="text-sm m-0">
              {sample.drawn} of {sample.population}{' '}
              {sample.kind === 'audit_events' ? 'audit events' : 'evidence rows'} for{' '}
              {sample.controlId} · seed <span className="k-num">{sample.seed}</span> (same seed,
              same sample){' '}
              {sampleCsvUrl ? (
                <a href={sampleCsvUrl} download data-testid="ia-sample-csv">
                  CSV
                </a>
              ) : null}
            </p>
            {sample.events ? (
              <Table
                label="Sampled events"
                columns={eventCols}
                rows={sample.events}
                rowKey={(e) => e.id}
                height={200}
                empty="Nothing in the period"
              />
            ) : (
              <pre className="text-xs overflow-auto max-h-48">
                {JSON.stringify(sample.rows, null, 1)}
              </pre>
            )}
          </div>
        ) : null}
      </Panel>

      <EvidenceExport testId="ia-evidence-export" />
    </div>
  );
}
