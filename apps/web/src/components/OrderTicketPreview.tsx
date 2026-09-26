'use client';

import type { OrderType, Side } from '@kora/domain';
import { KoraApiError, type InstrumentDetail, type OrderInput, type PreviewInput, type PreviewResponse, type RiskRejectionBody } from '@kora/sdk';
import { Button, Dialog, NumberInput, Select, formatMoney } from '@kora/ui';
import { useEffect, useMemo, useState } from 'react';

import { refreshAccount } from '@/lib/account';
import { api } from '@/lib/api-browser';

import { useShell } from './shell/ShellContext';

const LABEL: Record<OrderType, string> = {
  market: 'Market',
  limit: 'Limit',
  stop: 'Stop',
  stop_limit: 'Stop-limit',
  trailing: 'Trailing',
  bracket: 'Bracket',
  oco: 'OCO',
};

/** OCO needs two legs: the API supports it; the two-leg ticket editor is goal 04. */
const UNSUPPORTED_IN_TICKET: readonly OrderType[] = ['oco'];

function newClientOrderId(): string {
  return `web-${crypto.randomUUID()}`;
}

/**
 * Minimal order ticket wired to the goal 03 engine: every change is previewed by the server
 * (POST /orders/preview: notional, fees + spread, FX, margin impact, loss if the stop is hit,
 * reward:risk, risk verdict); placing uses a fresh client order id (idempotent). The full Pro
 * ticket (pips, hotkeys, depth-aware sizing) is goal 04.
 */
export function OrderTicketPreview({ symbol }: { symbol: string }) {
  const { me } = useShell();
  const types = me.capabilities.orderTypes;
  const [inst, setInst] = useState<InstrumentDetail | null>(null);
  const [side, setSide] = useState<Side>('buy');
  const [type, setType] = useState<OrderType>(types.includes('limit') ? 'limit' : (types[0] ?? 'market'));
  const [qty, setQty] = useState('');
  const [price, setPrice] = useState('');
  const [stopPrice, setStopPrice] = useState('');
  const [trail, setTrail] = useState('');
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [tif, setTif] = useState('gtc');
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .instrument(symbol)
      .then((i) => {
        if (cancelled) return;
        setInst(i);
        setQty((q) => q || i.minQty);
      })
      .catch(() => setInst(null));
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  const needsLimit = type === 'limit' || type === 'stop_limit';
  const needsStop = type === 'stop' || type === 'stop_limit';
  const body = useMemo(() => {
    if (!qty) return null;
    const b: Record<string, string> = { symbol, side, type, qty, tif };
    if (needsLimit) {
      if (!price) return null;
      b.limitPrice = price;
    }
    if (needsStop) {
      if (!stopPrice) return null;
      b.stopPrice = stopPrice;
    }
    if (type === 'trailing') {
      if (!trail) return null;
      b.trailAmount = trail;
    }
    if (UNSUPPORTED_IN_TICKET.includes(type)) return null;
    if (stopLoss) b.stopLossPrice = stopLoss;
    if (takeProfit) b.takeProfitPrice = takeProfit;
    if (type === 'bracket' && (!stopLoss || !takeProfit)) return null;
    return b;
  }, [symbol, side, type, qty, tif, price, stopPrice, trail, stopLoss, takeProfit, needsLimit, needsStop]);

  useEffect(() => {
    if (!body) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api
        .previewOrder(body as unknown as PreviewInput)
        .then((p) => !cancelled && setPreview(p))
        .catch(() => !cancelled && setPreview(null));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [body]);

  async function place() {
    if (!body) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await api.placeOrder({ ...body, clientOrderId: newClientOrderId() } as unknown as OrderInput);
      setResult({ tone: 'ok', text: `Order ${r.order.status.replace('_', ' ')}: ${r.order.side} ${r.order.qty} ${r.order.symbol}${r.order.avgFillPrice ? ` at ${r.order.avgFillPrice}` : ''}.` });
      setConfirm(false);
      refreshAccount();
      window.dispatchEvent(new Event('kora:blotter-refresh'));
    } catch (e) {
      const b = e instanceof KoraApiError ? (e.body as Partial<RiskRejectionBody> | undefined) : undefined;
      setResult({ tone: 'error', text: b?.code ? `Rejected (${b.code}): ${b.message}` : e instanceof KoraApiError ? e.message : 'The order failed.' });
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  }

  const p = preview?.preview;
  const ccy = p?.currency ?? 'USD';
  const precision = inst?.pricePrecision ?? 5;
  const qtyPrecision = inst?.qtyPrecision ?? 0;
  const violations = preview?.risk.violations ?? [];
  const review = () => (p?.confirmation.required ? setConfirm(true) : void place());

  return (
    <div className="flex flex-col gap-3" data-testid="order-ticket">
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Side">
        <Button variant="buy" role="radio" aria-checked={side === 'buy'} onClick={() => setSide('buy')} data-testid="ticket-side-buy" className={side === 'buy' ? 'outline-2 outline-offset-2 outline-text' : ''}>
          BUY ▲ {preview?.market.ask ?? ''}
        </Button>
        <Button variant="sell" role="radio" aria-checked={side === 'sell'} onClick={() => setSide('sell')} data-testid="ticket-side-sell" className={side === 'sell' ? 'outline-2 outline-offset-2 outline-text' : ''}>
          SELL ▼ {preview?.market.bid ?? ''}
        </Button>
      </div>
      <div role="radiogroup" aria-label="Order type" className="flex flex-wrap gap-1" data-testid="order-types">
        {types.map((t) => (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={type === t}
            onClick={() => setType(t)}
            className={`k-btn k-btn--sm ${type === t ? 'bg-raised! text-text!' : 'k-btn--ghost text-muted!'}`}
          >
            {LABEL[t]}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <NumberInput label="Quantity (units)" value={qty} onValueChange={setQty} precision={qtyPrecision} step={inst?.qtyStep ?? '1'} min="0" data-testid="ticket-qty" />
        <NumberInput label="Limit price" value={price} onValueChange={setPrice} precision={precision} step={inst?.tickSize ?? '0.00001'} min="0" placeholder="—" disabled={!needsLimit} data-testid="ticket-limit" />
        {needsStop ? <NumberInput label="Stop price" value={stopPrice} onValueChange={setStopPrice} precision={precision} step={inst?.tickSize ?? '0.00001'} min="0" data-testid="ticket-stop" /> : null}
        {type === 'trailing' ? <NumberInput label="Trail distance (price)" value={trail} onValueChange={setTrail} precision={precision} step={inst?.tickSize ?? '0.00001'} min="0" data-testid="ticket-trail" /> : null}
        <NumberInput label="Stop loss (price)" value={stopLoss} onValueChange={setStopLoss} precision={precision} step={inst?.tickSize ?? '0.00001'} min="0" placeholder="—" data-testid="ticket-sl" />
        <NumberInput label="Take profit (price)" value={takeProfit} onValueChange={setTakeProfit} precision={precision} step={inst?.tickSize ?? '0.00001'} min="0" placeholder="—" data-testid="ticket-tp" />
      </div>
      <Select
        label="Time in force"
        value={tif}
        onChange={(e) => setTif(e.target.value)}
        options={[
          { value: 'gtc', label: 'GTC' },
          { value: 'day', label: 'Day' },
          { value: 'ioc', label: 'IOC' },
          { value: 'fok', label: 'FOK' },
        ]}
      />
      {UNSUPPORTED_IN_TICKET.includes(type) ? (
        <p className="m-0 text-xs text-muted" data-testid="ticket-oco-note">
          OCO orders (two legs, one cancels the other) are supported by the engine and API; the two-leg ticket arrives with the Pro terminal (goal 04).
        </p>
      ) : null}
      <dl className="grid grid-cols-2 gap-y-1 text-xs m-0 k-num" data-testid="ticket-preview" aria-live="polite">
        <dt className="text-muted font-ui">Notional</dt>
        <dd className="m-0 text-right" data-testid="preview-notional">
          {p ? formatMoney(p.notional.base, ccy) : '—'}
        </dd>
        <dt className="text-muted font-ui">Est. fees + spread</dt>
        <dd className="m-0 text-right" data-testid="preview-fees">
          {p ? formatMoney(p.fees.total, ccy) : '—'}
        </dd>
        {p?.fx ? (
          <>
            <dt className="text-muted font-ui">FX {p.fx.from}→{p.fx.to} (conversion)</dt>
            <dd className="m-0 text-right" data-testid="preview-fx">
              {p.fx.rate} · {formatMoney(p.fx.conversionCost, ccy)}
            </dd>
          </>
        ) : null}
        <dt className="text-muted font-ui">Margin impact</dt>
        <dd className="m-0 text-right" data-testid="preview-margin">
          {p ? formatMoney(p.margin.required, ccy) : '—'}
        </dd>
        <dt className="text-muted font-ui">Loss if stop hit</dt>
        <dd className="m-0 text-right" data-testid="preview-loss">
          {p?.lossIfStopHit ? `−${formatMoney(p.lossIfStopHit.total, ccy)} · ${p.lossIfStopHit.pctEquity}% eq.` : p ? 'No stop: not capped' : '—'}
        </dd>
        <dt className="text-muted font-ui">Reward : risk</dt>
        <dd className="m-0 text-right" data-testid="preview-rr">
          {p?.rewardRisk ? `1 : ${p.rewardRisk}` : '—'}
        </dd>
      </dl>
      {violations.length ? (
        <ul className="m-0 pl-4 text-xs k-error" data-testid="preview-violations">
          {violations.map((v) => (
            <li key={v.code}>
              <strong>{v.code}</strong>: {v.message}
            </li>
          ))}
        </ul>
      ) : null}
      <Button variant="primary" block disabled={!p || busy || violations.length > 0} onClick={review} data-testid="place-order">
        Review {side === 'buy' ? 'Buy' : 'Sell'} {qty || ''} {symbol}
      </Button>
      {result ? (
        <p className={`m-0 text-sm ${result.tone === 'error' ? 'k-error' : ''}`} role="status" data-testid="ticket-result">
          {result.text}
        </p>
      ) : null}
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Confirm ${side} ${qty} ${symbol}`}
        description="Paper order with simulated market data."
        data-testid="confirm-order"
      >
        {p ? (
          <ul className="m-0 pl-4 text-sm">
            {p.confirmation.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
            <li>
              Fees + spread {formatMoney(p.fees.total, ccy)}; margin {formatMoney(p.margin.required, ccy)}
              {p.lossIfStopHit ? `; loss if the stop is hit −${formatMoney(p.lossIfStopHit.total, ccy)}` : ''}.
            </li>
          </ul>
        ) : null}
        <div className="k-dialog__actions">
          <Button onClick={() => setConfirm(false)}>Back</Button>
          <Button variant="primary" onClick={() => void place()} disabled={busy} data-testid="confirm-place">
            Place order
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
