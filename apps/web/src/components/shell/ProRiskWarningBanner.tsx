'use client';

import type { DisclosureDocument } from '@kora/sdk';
import { Banner, Button } from '@kora/ui';
import { useEffect, useState } from 'react';

import { api } from '@/lib/api-browser';

/**
 * IRTC R4-09: every account acknowledges the risk warning in force before an order that adds
 * exposure. Traders do it when they pass the appropriateness assessment; a Pro account that has not
 * (staff roles, or a new version or figure published since) confirms it here. Orders that reduce a
 * position are never blocked.
 */
export function ProRiskWarningBanner({ className }: { className?: string }) {
  const [doc, setDoc] = useState<DisclosureDocument | null>(null);
  const [needed, setNeeded] = useState(false);
  const [open, setOpen] = useState(false);
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .disclosure('risk-warning', 'en')
      .then((r) => {
        if (cancelled) return;
        setDoc(r.document);
        setNeeded(!r.acknowledged);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!needed || !doc) return null;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.acknowledgeDisclosure('risk-warning', {
        version: doc.version,
        contentHash: doc.contentHash,
        locale: 'en',
        context: 'banner',
      });
      setNeeded(false);
    } catch {
      setError(
        'The risk warning changed or could not be saved. Reload the page and confirm again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={className} data-testid="pro-risk-warning">
      <Banner tone="warn" title="Confirm the risk warning before trading">
        <span className="block">
          New orders that add exposure need the current risk warning confirmed. Closing or reducing
          positions always works.
        </span>
        {open ? (
          <div className="mt-2 flex flex-col gap-2">
            <strong>{doc.title}</strong>
            <ul className="m-0 pl-5 flex flex-col gap-1">
              {doc.body.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            <label className="flex gap-2 items-start cursor-pointer">
              <input
                type="checkbox"
                checked={ticked}
                onChange={(e) => setTicked(e.target.checked)}
                data-testid="pro-risk-warning-ack"
              />
              <span className="font-semibold">{doc.acknowledge}</span>
            </label>
            {error ? <span role="alert">{error}</span> : null}
            <div>
              <Button
                size="sm"
                variant="primary"
                disabled={!ticked || busy}
                onClick={() => void confirm()}
                data-testid="pro-risk-warning-confirm"
              >
                Confirm
              </Button>
            </div>
          </div>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            className="mt-2"
            onClick={() => setOpen(true)}
            data-testid="pro-risk-warning-open"
          >
            Read and confirm
          </Button>
        )}
      </Banner>
    </div>
  );
}
