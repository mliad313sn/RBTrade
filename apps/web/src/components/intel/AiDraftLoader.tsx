'use client';

import { useEffect } from 'react';

import { terminalApi } from '@/lib/terminal/store';

interface OrderDraftDto {
  id: string;
  kind: 'order';
  status: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  qty: string;
  limitPrice: string | null;
  stopLossPrice: string | null;
  takeProfitPrice: string | null;
  rationale: string;
}

/**
 * Opens an audited AI order draft (e.g. Market Radar "Draft to ticket") in the terminal ticket from
 * `?aiDraft=<id>`. It only pre-fills: the user still previews and confirms, and the ticket records the
 * decision against the draft (goal 07).
 */
export function AiDraftLoader({ draftId }: { draftId: string | null }) {
  useEffect(() => {
    if (!draftId || !/^[0-9a-f-]{36}$/i.test(draftId)) return;
    let cancelled = false;
    void fetch(`/api/ai/drafts/${draftId}`, {
      credentials: 'include',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    })
      .then((r) => (r.ok ? (r.json() as Promise<OrderDraftDto>) : null))
      .then((d) => {
        if (cancelled || !d || d.kind !== 'order' || d.status !== 'draft') return;
        // Let the terminal mount (and pick its symbol) first; the ticket applies the draft on change.
        setTimeout(() => {
          terminalApi.prefillTicket({
            symbol: d.symbol,
            side: d.side,
            type: d.type,
            qty: d.qty,
            limitPrice: d.limitPrice ?? undefined,
            stopLossPrice: d.stopLossPrice ?? undefined,
            takeProfitPrice: d.takeProfitPrice ?? undefined,
            origin: 'ai',
            aiDraftId: d.id,
            // IRTC R4-15: the rationale is model text, labelled as such.
            note: `AI draft ${d.id.slice(0, 8)} · copilot's words, not advice: ${d.rationale.slice(0, 80)}`,
          });
        }, 300);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [draftId]);
  return null;
}
