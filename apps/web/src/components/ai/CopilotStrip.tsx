'use client';

import './ai.css';

import { isNoviceOnly } from '@kora/domain';
import { useCallback, useEffect, useState } from 'react';

import { useShell } from '@/components/shell/ShellContext';
import { aiApi, type DraftRef, type StripData } from '@/lib/ai/client';
import type { AiStripSlotProps } from '@/lib/terminal/ai-strip';
import type { TicketDraft } from '@/lib/terminal/store';

import { CopilotChat } from './CopilotChat';

const REFRESH_MS = 60_000;

function arrow(x: number): string {
  return x > 0 ? '▲' : x < 0 ? '▼' : '•';
}

const SHORT: Record<string, string> = {
  emaSpread: 'EMA 20/50',
  momentum: 'momentum',
  rsi: 'RSI 14',
};

function toTicketDraft(prefill: Record<string, string>): Omit<TicketDraft, 'origin'> {
  return {
    symbol: prefill.symbol,
    side: prefill.side as TicketDraft['side'],
    type: prefill.type as TicketDraft['type'],
    qty: prefill.qty,
    limitPrice: prefill.limitPrice,
    stopLossPrice: prefill.stopLossPrice,
    takeProfitPrice: prefill.takeProfitPrice,
    note: prefill.note,
    aiDraftId: prefill.aiDraftId,
  };
}

/**
 * Terminal AI strip (goal 07): bias, calibrated confidence or "No edge after costs", top drivers,
 * event risk, "Draft to ticket" and a "Why?" disclosure. Every figure comes from `GET /ai/strip`
 * (data and the calibration table); the model is only used when the user asks a question.
 */
export function CopilotStrip(props: AiStripSlotProps) {
  const { me } = useShell();
  // A novice-only account may look at the Pro view (goal 08), but it stays guarded and the copilot
  // always answers it in novice mode (goal 07): the Pro strip (bias, drafts) is not for it.
  if (isNoviceOnly(me.roles)) {
    return (
      <>
        <span className="ai-strip__mark" aria-hidden="true">
          ✦
        </span>
        <span className="ai-strip__label">Copilot</span>
        <span className="ai-strip__text" data-testid="ai-strip-novice">
          The Pro copilot needs a trader account. In the Simple view, use “Explain this to me”.
        </span>
      </>
    );
  }
  return <ProCopilotStrip {...props} />;
}

function ProCopilotStrip({ symbol, timeframe, prefillTicket }: AiStripSlotProps) {
  const [data, setData] = useState<StripData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await aiApi.strip(symbol, timeframe));
      setError(null);
    } catch (e) {
      setError((e as Error).message || 'Copilot data unavailable.');
    }
  }, [symbol, timeframe]);

  useEffect(() => {
    setData(null);
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  async function draft() {
    setBusy(true);
    setNotice(null);
    try {
      const d = await aiApi.stripDraft(symbol, timeframe);
      if (d.status === 'draft') prefillTicket(toTicketDraft(d.prefill));
      else setNotice(d.message);
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const openOrderDraft = (d: DraftRef) => d.prefill && prefillTicket(toTicketDraft(d.prefill));

  if (error) {
    return (
      <>
        <span className="ai-strip__mark" aria-hidden="true">
          ✦
        </span>
        <span className="ai-strip__label">Copilot</span>
        <span className="ai-strip__text">{error}</span>
      </>
    );
  }
  if (!data) {
    return (
      <>
        <span className="ai-strip__mark" aria-hidden="true">
          ✦
        </span>
        <span className="ai-strip__label">Copilot</span>
        <span className="ai-strip__text">Loading…</span>
      </>
    );
  }
  const conf = data.confidence;
  return (
    <>
      <span className="ai-strip__mark" aria-hidden="true">
        ✦
      </span>
      <span className="ai-strip__label">Copilot</span>
      <span className="ai-strip__main" data-testid="ai-strip-bias">
        <strong>{data.bias.label}</strong>
        {conf ? (
          <>
            {' · conf '}
            <span className="k-num" data-testid="ai-strip-confidence">
              {conf.value.toFixed(2)}
            </span>{' '}
            <span className="text-muted">(calibrated, n={conf.n})</span>
          </>
        ) : (
          <span className="text-muted" data-testid="ai-strip-confidence-none">
            {' · no calibrated confidence'}
          </span>
        )}
        {data.edge === 'none' ? (
          <span className="ai-strip__noedge" data-testid="ai-strip-noedge">
            {' · '}
            {data.edgeStatement}
          </span>
        ) : null}
      </span>
      <span className="ai-strip__drivers text-muted" data-testid="ai-strip-drivers">
        Drivers:{' '}
        {data.drivers.map((d, i) => (
          <span key={d.key}>
            {i ? ', ' : ''}
            {SHORT[d.key] ?? d.label} {arrow(d.contribution)}
          </span>
        ))}
        {data.eventRisk[0]
          ? `, event risk: ${data.eventRisk[0].title} in ${data.eventRisk[0].minutesAway} min`
          : ''}
      </span>
      <button
        type="button"
        className="ai-strip__btn"
        onClick={() => void draft()}
        disabled={busy || !data.canDraft}
        data-testid="ai-strip-draft"
      >
        {busy ? 'Drafting…' : 'Draft to ticket'}
      </button>
      <button
        type="button"
        className="ai-strip__why"
        aria-expanded={open}
        aria-controls="ai-strip-why"
        onClick={() => setOpen((o) => !o)}
        data-testid="ai-strip-why-toggle"
      >
        Why?
      </button>
      {notice ? (
        <span className="ai-strip__notice" role="status">
          {notice}
        </span>
      ) : null}
      {open ? (
        <div
          id="ai-strip-why"
          className="ai-strip__pop"
          role="region"
          aria-label="Why this bias"
          data-testid="ai-strip-why"
        >
          <p className="ai-strip__line" data-testid="ai-strip-reliability">
            {data.reliabilityLine ??
              `No calibrated confidence for this score (n=${data.calibration.n}, need ${data.calibration.minN} per bin).`}
          </p>
          <p className="ai-strip__line">{data.edgeStatement}</p>
          <table className="ai-strip__table">
            <caption className="k-sr-only">Bias drivers (data)</caption>
            <thead>
              <tr>
                <th scope="col">Driver</th>
                <th scope="col">Value</th>
                <th scope="col">Contribution</th>
              </tr>
            </thead>
            <tbody>
              {data.drivers.map((d) => (
                <tr key={d.key}>
                  <td>{d.label}</td>
                  <td className="k-num">{d.value}</td>
                  <td className="k-num">
                    {arrow(d.contribution)} {d.contribution > 0 ? '+' : ''}
                    {d.contribution}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="ai-strip__method text-muted">{data.method}</p>
          <CopilotChat
            compact
            context={{ panel: 'chart', symbol, timeframe }}
            placeholder={`Ask about ${symbol}…`}
            onOrderDraft={openOrderDraft}
          />
          <p className="ai-strip__disclaimer text-muted">
            SIMULATED data · the copilot drafts, you decide · {data.disclaimer}
          </p>
        </div>
      ) : null}
    </>
  );
}
