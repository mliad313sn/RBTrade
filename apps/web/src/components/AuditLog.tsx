'use client';

import type { AuditEvent } from '@kora/domain';
import type { AuditVerifyResponse } from '@kora/sdk';
import { Banner, Button, Panel, Table, type Column } from '@kora/ui';
import { useCallback, useEffect, useState } from 'react';

import { api } from '@/lib/api-browser';

const columns: Column<AuditEvent>[] = [
  { key: 'id', header: '#', width: '64px', numeric: true, cell: (e) => e.id },
  { key: 'ts', header: 'Time (UTC)', width: '220px', cell: (e) => <span className="k-num">{e.ts.replace('T', ' ').replace('Z', '')}</span> },
  { key: 'action', header: 'Action', cell: (e) => e.action },
  { key: 'entity', header: 'Entity', cell: (e) => `${e.entity}${e.entityId ? ` · ${e.entityId}` : ''}` },
  { key: 'actor', header: 'Actor', width: '90px', cell: (e) => e.actorType },
  { key: 'hash', header: 'Hash', width: '120px', cell: (e) => <span className="k-num" title={e.hash}>{e.hash.slice(0, 10)}…</span> },
];

export function AuditLog() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [verify, setVerify] = useState<AuditVerifyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setEvents((await api.audit({ limit: 200 })).events);
      setError(null);
    } catch {
      setError('Could not load the audit log.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className="grid gap-3">
      <Panel
        title="Audit log (append-only, hash-chained)"
        actions={
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void load()}>
              Refresh
            </Button>
            <Button size="sm" variant="primary" onClick={async () => setVerify(await api.verifyAudit())} data-testid="verify-chain">
              Verify chain
            </Button>
          </div>
        }
      >
        {error ? <Banner tone="critical">{error}</Banner> : null}
        {verify ? (
          <div data-testid="verify-result">
            <Banner tone={verify.valid ? 'info' : 'critical'} title={verify.valid ? 'Chain valid.' : 'Chain broken.'}>
              {verify.valid
                ? (verify as { scope?: string }).scope === 'own'
                  ? `${verify.count} of your events recomputed and linked into the chain. Latest ${verify.headHash.slice(0, 16)}…`
                  : `${verify.count} events recomputed. Head ${verify.headHash.slice(0, 16)}…`
                : `First broken event #${verify.firstBrokenId} (${verify.reason}).`}
            </Banner>
          </div>
        ) : null}
        <Table label="Audit events" columns={columns} rows={events} rowKey={(e) => e.id} height={480} empty="No events yet" />
      </Panel>
    </div>
  );
}
