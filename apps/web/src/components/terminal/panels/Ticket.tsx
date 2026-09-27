'use client';

import {
  dec,
  isDecimalString,
  pipSizeOf,
  protectivePrice,
  ticketWarnings,
  unitsFromQtyInput,
  type CalendarEvent,
  type DistanceMode,
  type OrderType,
  type QtyMode,
  type Side,
  type TimeInForce,
} from '@kora/domain';
import { KoraApiError, type InstrumentDetail, type OrderInput, type PreviewInput, type PreviewResponse, type RiskRejectionBody } from '@kora/sdk';
import { Button, Dialog, HoldToConfirmButton, NumberInput, formatMoney, formatPrice, useToast } from '@kora/ui';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useShell } from '@/components/shell/ShellContext';
import { recordAiDecision } from '@/lib/ai/decision';
import { api } from '@/lib/api-browser';
import { formatQty } from '@/lib/terminal/format';
import { useTerminal } from '@/lib/terminal/store';
import { refreshTrading, useTrading } from '@/lib/terminal/trading';

import { useMarket, useTerminalSettings } from '../TerminalContext';

const LABEL: Record<OrderType, string> = {
  market: 'Market',
  limit: 'Limit',
  stop: 'Stop',
  stop_limit: 'Stop-limit',
  trailing: 'Trailing',
  bracket: 'Bracket',
  oco: 'OCO',
};
const QTY_LABEL: Record<QtyMode, string> = { units: 'units', notional: 'notional', pct_equity: '% equity' };
const DIST_LABEL: Record<DistanceMode, string> = { price: 'price', pips: 'pips', percent: '%' };
export const PREVIEW_DEBOUNCE_MS = 150;
/** Upper bound between previews while the body keeps changing (market-relative stops move every tick). */
export const PREVIEW_MAX_WAIT_MS = 500;
export const MARKET_HOLD_MS = 600;

interface OcoLegInput {
  type: 'limit' | 'stop' | 'stop_limit';
  limitPrice: string;
  stopPrice: string;
}

function newClientOrderId(): string {
  return `web-${crypto.randomUUID()}`;
}

/** Small inline unit selector used next to a field label. */
function ModeSelect<T extends string>({ label, value, options, onChange, testId }: { label: string; value: T; options: Record<T, string>; onChange: (v: T) => void; testId?: string }) {
  return (
    <select className="tk-mode" aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)} data-testid={testId}>
      {(Object.keys(options) as T[]).map((k) => (
        <option key={k} value={k}>
          {options[k]}
        </option>
      ))}
    </select>
  );
}

function FieldHead({ children, mode }: { children: ReactNode; mode?: ReactNode }) {
  return (
    <div className="tk-fhead">
      <span className="k-label">{children}</span>
      {mode}
    </div>
  );
}

/**
 * Pro order ticket (goal 04, B-305). Every change is previewed by the server (POST /orders/preview,
 * debounced 150 ms): notional, fees + spread, FX, margin impact, loss if the stop is hit,
 * reward:risk and the risk verdict. Quantities in units, notional or % equity; SL/TP in price,
 * pips or %. Orders above the user's thresholds open a confirmation; market orders above them need
 * a 600 ms hold. Keyboard: B/S pick the side, Ctrl+Enter reviews, Enter confirms, Esc closes.
 */
export function TicketPanel() {
  const { me } = useShell();
  const toast = useToast();
  const store = useMarket();
  const settings = useTerminalSettings();
  const symbol = useTerminal((s) => s.symbol);
  const draft = useTerminal((s) => s.draft);
  const focus = useTerminal((s) => s.focus);
  const account = useTrading((s) => s.account);
  const types = me.capabilities.orderTypes;

  const [inst, setInst] = useState<InstrumentDetail | null>(null);
  const [side, setSide] = useState<Side>('buy');
  const [type, setType] = useState<OrderType>(types.includes('limit') ? 'limit' : (types[0] ?? 'market'));
  const [qtyMode, setQtyMode] = useState<QtyMode>('units');
  const [qtyInput, setQtyInput] = useState('');
  const [limitPrice, setLimitPrice] = useState('');
  const [stopPrice, setStopPrice] = useState('');
  const [trailMode, setTrailMode] = useState<'price' | 'pips'>('pips');
  const [trailInput, setTrailInput] = useState('');
  const [slMode, setSlMode] = useState<DistanceMode>('pips');
  const [slInput, setSlInput] = useState('');
  const [tpMode, setTpMode] = useState<DistanceMode>('pips');
  const [tpInput, setTpInput] = useState('');
  const [tif, setTif] = useState<TimeInForce>('gtc');
  const [expireAt, setExpireAt] = useState('');
  const [reduceOnly, setReduceOnly] = useState(false);
  const [postOnly, setPostOnly] = useState(false);
  const [entryType, setEntryType] = useState<'market' | 'limit'>('market');
  const [legs, setLegs] = useState<[OcoLegInput, OcoLegInput]>([
    { type: 'limit', limitPrice: '', stopPrice: '' },
    { type: 'stop', limitPrice: '', stopPrice: '' },
  ]);
  const [origin, setOrigin] = useState<'manual' | 'ai' | string>('manual');
  const [note, setNote] = useState<string | null>(null);
  const [aiDraftId, setAiDraftId] = useState<string | null>(null);
  const [quote, setQuote] = useState<{ bid: string; ask: string; stale: boolean } | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [fxRate, setFxRate] = useState<string | null>(null);
  const buyRef = useRef<HTMLButtonElement>(null);
  const sellRef = useRef<HTMLButtonElement>(null);
  const qtyRef = useRef<HTMLInputElement>(null);
  const previewSeq = useRef(0);
  const lastPreviewAt = useRef(0);

  // Instrument (registry grid) and a fresh quantity default per symbol.
  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setFxRate(null);
    api
      .instrument(symbol)
      .then((i) => {
        if (cancelled) return;
        setInst(i);
        setQtyInput((q) => (q && draft?.symbol !== symbol ? q : i.minQty));
      })
      .catch(() => !cancelled && setInst(null));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  useEffect(() => {
    setQuote(null);
    return store.onQuote(symbol, (q) => setQuote({ bid: q.bid, ask: q.ask, stale: !!q.stale }));
  }, [store, symbol]);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .calendar({ from: Date.now(), to: Date.now() + 2 * 3600_000 })
        .then((r) => !cancelled && setEvents(r.events))
        .catch(() => undefined);
    void load();
    const t = setInterval(load, 5 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  // Drafts (order book, chart, blotter, goal 07 copilot) prefill the ticket; the user still reviews.
  useEffect(() => {
    if (!draft) return;
    if (draft.side) setSide(draft.side);
    if (draft.type && types.includes(draft.type)) setType(draft.type);
    else if (draft.limitPrice && !draft.type && types.includes('limit')) setType('limit');
    if (draft.qty) {
      setQtyMode('units');
      setQtyInput(draft.qty);
    }
    if (draft.limitPrice) setLimitPrice(draft.limitPrice);
    if (draft.stopPrice) setStopPrice(draft.stopPrice);
    if (draft.trailAmount) {
      setTrailMode('price');
      setTrailInput(draft.trailAmount);
    }
    if (draft.stopLossPrice) {
      setSlMode('price');
      setSlInput(draft.stopLossPrice);
    }
    if (draft.takeProfitPrice) {
      setTpMode('price');
      setTpInput(draft.takeProfitPrice);
    }
    if (draft.tif) setTif(draft.tif);
    if (draft.reduceOnly !== undefined) setReduceOnly(draft.reduceOnly);
    setOrigin(draft.origin ?? 'manual');
    setNote(draft.note ?? null);
    setAiDraftId(draft.origin === 'ai' ? (draft.aiDraftId ?? null) : null);
    setResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.nonce]);

  const quoteCcy = inst?.quoteCcy;
  const accountCcy = account?.baseCurrency ?? 'USD';
  // Quote → account currency rate for notional / % equity sizing (from a minimum-size preview).
  useEffect(() => {
    if (!inst || !quoteCcy) return;
    if (quoteCcy === accountCcy) {
      setFxRate('1');
      return;
    }
    let cancelled = false;
    api
      .previewOrder({ symbol, side: 'buy', type: 'market', qty: inst.minQty } as PreviewInput)
      .then((p) => !cancelled && setFxRate(p.preview?.fx?.rate ?? null))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [inst, symbol, quoteCcy, accountCcy]);

  const precision = inst?.pricePrecision ?? 5;
  const tick = inst?.tickSize ?? '0.00001';
  // B-202: minor-unit quotes (GBX, ZAc) scale prices to the quote currency until the preview answers.
  const multiplier =
    preview?.instrument.multiplier ??
    (inst?.priceUnitFactor ? dec(inst.contractSize).mul(dec(inst.priceUnitFactor)).toFixed() : (inst?.contractSize ?? '1'));
  const needsLimit = type === 'limit' || type === 'stop_limit' || (type === 'bracket' && entryType === 'limit');
  const needsStop = type === 'stop' || type === 'stop_limit';
  const marketRef = quote ? (side === 'buy' ? quote.ask : quote.bid) : null;
  const entry = needsLimit && limitPrice ? limitPrice : needsStop && stopPrice ? stopPrice : marketRef;

  const units = useMemo(() => {
    if (!inst) return null;
    return unitsFromQtyInput({ mode: qtyMode, value: qtyInput, price: entry, multiplier, qtyStep: inst.qtyStep, equity: account?.equity ?? null, fxRate });
  }, [inst, qtyMode, qtyInput, entry, multiplier, account?.equity, fxRate]);

  const slPrice = inst && type !== 'oco' ? protectivePrice({ kind: 'sl', mode: slMode, value: slInput, side, entry, spec: inst }) : null;
  const tpPrice = inst && type !== 'oco' ? protectivePrice({ kind: 'tp', mode: tpMode, value: tpInput, side, entry, spec: inst }) : null;
  const trailAmount = inst && trailInput && isDecimalString(trailInput) && dec(trailInput).gt(0) ? (trailMode === 'pips' ? dec(trailInput).mul(pipSizeOf(inst)).toFixed() : trailInput) : null;

  const body = useMemo((): Record<string, unknown> | null => {
    if (!inst || !units || units.lte(0)) return null;
    const b: Record<string, unknown> = { symbol, side, type, qty: units.toFixed(), tif };
    if (tif === 'gtd') {
      if (!expireAt) return null;
      b.expireAt = new Date(expireAt).toISOString();
    }
    if (reduceOnly) b.reduceOnly = true;
    if (postOnly) b.postOnly = true;
    if (origin === 'ai') b.source = 'ai-draft-accepted';
    if (type === 'oco') {
      const out = legs.map((l) => ({ type: l.type, ...(l.type !== 'stop' ? { limitPrice: l.limitPrice } : {}), ...(l.type !== 'limit' ? { stopPrice: l.stopPrice } : {}) }));
      if (out.some((l) => ('limitPrice' in l && !l.limitPrice) || ('stopPrice' in l && !l.stopPrice))) return null;
      b.legs = out;
      return b;
    }
    if (needsLimit) {
      if (!limitPrice) return null;
      b.limitPrice = limitPrice;
    }
    if (needsStop) {
      if (!stopPrice) return null;
      b.stopPrice = stopPrice;
    }
    if (type === 'trailing') {
      if (!trailAmount) return null;
      b.trailAmount = trailAmount;
    }
    if (type === 'bracket') {
      b.entryType = entryType;
      if (!slPrice || !tpPrice) return null;
    }
    if (slPrice && !reduceOnly) b.stopLossPrice = slPrice.toFixed();
    if (tpPrice && !reduceOnly) b.takeProfitPrice = tpPrice.toFixed();
    return b;
  }, [inst, units, symbol, side, type, tif, expireAt, reduceOnly, postOnly, origin, legs, needsLimit, needsStop, limitPrice, stopPrice, trailAmount, entryType, slPrice, tpPrice]);

  const bodyKey = body ? JSON.stringify(body) : null;
  useEffect(() => {
    if (!bodyKey) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const seq = ++previewSeq.current;
    // Debounce, but never starve: with a stop in % or pips the body changes on every tick.
    const delay = Date.now() - lastPreviewAt.current >= PREVIEW_MAX_WAIT_MS ? 0 : PREVIEW_DEBOUNCE_MS;
    const t = setTimeout(() => {
      lastPreviewAt.current = Date.now();
      api
        .previewOrder(JSON.parse(bodyKey) as PreviewInput)
        .then((p) => {
          if (seq !== previewSeq.current) return;
          setPreview(p);
          setPreviewError(null);
        })
        .catch((e: unknown) => {
          if (seq !== previewSeq.current) return;
          setPreview(null);
          setPreviewError(e instanceof KoraApiError ? e.message : 'Preview unavailable');
        });
    }, delay);
    return () => clearTimeout(t);
  }, [bodyKey]);

  const p = preview?.preview ?? null;
  const ccy = p?.currency ?? accountCcy;
  const violations = preview?.risk.violations ?? [];
  const warnings = ticketWarnings({
    lossPctEquity: p?.lossIfStopHit?.pctEquity ?? null,
    perTradeRiskPct: settings.perTradeRiskPct,
    hasStop: Boolean(slPrice) || type === 'oco' || reduceOnly,
    events,
    currencies: [inst?.baseCcy, inst?.quoteCcy].filter((c): c is string => Boolean(c)),
    now: Date.now(),
    session: preview?.market.session ?? inst?.session?.state ?? null,
    dataState: preview?.market.dataState ?? null,
  });
  const isMarketLike = type === 'market' || (type === 'bracket' && entryType === 'market') || type === 'trailing';
  const canSubmit = Boolean(p && body && !busy && violations.length === 0);

  const place = useCallback(async () => {
    if (!body) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await api.placeOrder({ ...body, clientOrderId: newClientOrderId() } as unknown as OrderInput);
      const o = r.order;
      const text = `Order ${o.status.replace('_', ' ')}: ${o.side} ${formatQty(o.qty, inst?.qtyPrecision ?? 0)} ${o.symbol}${o.avgFillPrice ? ` at ${o.avgFillPrice}` : ''}.`;
      setResult({ tone: 'ok', text });
      toast.push(text, 'success', 4000);
      setConfirm(false);
      // Goal 07: the user placed the order from an AI draft; record the human decision (audited).
      if (origin === 'ai' && aiDraftId) void recordAiDecision(aiDraftId, { decision: 'accepted', orderId: o.id });
      setOrigin('manual');
      setNote(null);
      setAiDraftId(null);
      refreshTrading();
    } catch (e) {
      const b = e instanceof KoraApiError ? (e.body as Partial<RiskRejectionBody> | undefined) : undefined;
      setResult({ tone: 'error', text: b?.code ? `Rejected (${b.code}): ${b.message}` : e instanceof KoraApiError ? e.message : 'The order failed.' });
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  }, [body, inst?.qtyPrecision, toast, origin, aiDraftId]);

  const review = useCallback(() => {
    if (!canSubmit || !p) return;
    if (p.confirmation.required) setConfirm(true);
    else void place();
  }, [canSubmit, p, place]);

  // Hotkeys (B/S focus the side, Ctrl+Enter reviews), requested through the terminal store.
  useEffect(() => {
    if (!focus) return;
    if (focus.target === 'ticket-buy' || focus.target === 'ticket-sell') {
      const s: Side = focus.target === 'ticket-buy' ? 'buy' : 'sell';
      setSide(s);
      (s === 'buy' ? buyRef : sellRef).current?.focus();
    } else if (focus.target === 'ticket-submit') {
      review();
    } else if (focus.target === 'ticket') {
      qtyRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  const qtyPrecision = qtyMode === 'units' ? (inst?.qtyPrecision ?? 0) : 2;
  const distPrecision = (m: DistanceMode) => (m === 'price' ? precision : m === 'pips' ? 1 : 2);
  const displayName = inst?.displayName ?? symbol;
  const qtyLabel = units ? formatQty(units.toFixed(), inst?.qtyPrecision ?? 0) : qtyInput || '';
  const marginRatio = p && dec(p.margin.rate).gt(0) ? `1:${dec(1).div(dec(p.margin.rate)).toDecimalPlaces(0).toFixed()}` : null;

  return (
    <div className="tk flex flex-col gap-2 h-full overflow-auto" data-testid="order-ticket" data-panel-root="ticket" tabIndex={-1}>
      {note ? (
        <p className="tk-note" data-testid="ticket-note">
          <span className="text-ai">✦ Draft</span> {note} <span className="text-muted">Review before placing.</span>
          {aiDraftId ? (
            <button
              type="button"
              className="tk-note__dismiss"
              onClick={() => {
                void recordAiDecision(aiDraftId, { decision: 'rejected' });
                setAiDraftId(null);
                setNote(null);
                setOrigin('manual');
              }}
              data-testid="ticket-draft-dismiss"
            >
              Dismiss draft
            </button>
          ) : null}
        </p>
      ) : null}
      {quote?.stale ? (
        // Goal 10 chaos finding: the last price stayed on the buttons without a marker while the feed was down.
        <p className="m-0 text-xs text-warn" role="status" data-testid="ticket-stale">
          ⚠ Stale price: the feed is not live. Orders that need a price are refused until it recovers.
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Side">
        <button ref={buyRef} type="button" role="radio" aria-checked={side === 'buy'} onClick={() => setSide('buy')} className={`tk-side tk-side--buy ${side === 'buy' ? 'is-on' : ''}`} data-testid="ticket-side-buy">
          BUY ▲ <span className="k-num">{quote ? formatPrice(quote.ask, precision) : ''}</span>{quote?.stale ? <span className="text-xs"> Stale</span> : null}
        </button>
        <button ref={sellRef} type="button" role="radio" aria-checked={side === 'sell'} onClick={() => setSide('sell')} className={`tk-side tk-side--sell ${side === 'sell' ? 'is-on' : ''}`} data-testid="ticket-side-sell">
          SELL ▼ <span className="k-num">{quote ? formatPrice(quote.bid, precision) : ''}</span>{quote?.stale ? <span className="text-xs"> Stale</span> : null}
        </button>
      </div>
      <div role="radiogroup" aria-label="Order type" className="flex flex-wrap gap-1" data-testid="order-types">
        {types.map((t) => (
          <button key={t} type="button" role="radio" aria-checked={type === t} onClick={() => setType(t)} className={`tk-type ${type === t ? 'is-on' : ''}`}>
            {LABEL[t]}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-x-2 gap-y-1">
        <div>
          <FieldHead mode={<ModeSelect label="Quantity unit" value={qtyMode} options={QTY_LABEL} onChange={(m) => { setQtyMode(m); setQtyInput(''); }} testId="ticket-qty-mode" />}>Qty ({QTY_LABEL[qtyMode]})</FieldHead>
          <NumberInput ref={qtyRef} label={`Quantity (${QTY_LABEL[qtyMode]})`} hideLabel value={qtyInput} onValueChange={setQtyInput} precision={qtyPrecision} step={qtyMode === 'units' ? (inst?.qtyStep ?? '1') : '1'} min="0" data-testid="ticket-qty" hint={qtyMode !== 'units' && units ? `= ${formatQty(units.toFixed(), inst?.qtyPrecision ?? 0)} units` : undefined} />
        </div>
        {type === 'bracket' ? (
          <div>
            <FieldHead mode={<ModeSelect label="Bracket entry" value={entryType} options={{ market: 'market', limit: 'limit' }} onChange={setEntryType} />}>Entry</FieldHead>
            <NumberInput label="Limit price" hideLabel value={limitPrice} onValueChange={setLimitPrice} precision={precision} step={tick} min="0" placeholder={entryType === 'market' ? 'Market' : '—'} disabled={entryType === 'market'} data-testid="ticket-limit" />
          </div>
        ) : type === 'oco' ? (
          <div className="text-[11px] text-muted self-end pb-1">Two legs: one cancels the other.</div>
        ) : (
          <div>
            <FieldHead>
              {needsStop && !needsLimit ? 'Stop price' : 'Limit price'}
              {inst?.priceUnit ? <span data-testid="ticket-price-unit"> ({inst.priceUnit}, amounts in {inst.quoteCcy})</span> : null}
            </FieldHead>
            {needsStop && !needsLimit ? (
              <NumberInput label="Stop price" hideLabel value={stopPrice} onValueChange={setStopPrice} precision={precision} step={tick} min="0" data-testid="ticket-stop" />
            ) : (
              <NumberInput label="Limit price" hideLabel value={limitPrice} onValueChange={setLimitPrice} precision={precision} step={tick} min="0" placeholder={needsLimit ? '' : 'Market'} disabled={!needsLimit} data-testid="ticket-limit" />
            )}
          </div>
        )}
        {type === 'stop_limit' ? (
          <div className="col-span-2">
            <FieldHead>Stop (trigger) price</FieldHead>
            <NumberInput label="Stop price" hideLabel value={stopPrice} onValueChange={setStopPrice} precision={precision} step={tick} min="0" data-testid="ticket-stop" />
          </div>
        ) : null}
        {type === 'trailing' ? (
          <div className="col-span-2">
            <FieldHead mode={<ModeSelect label="Trail unit" value={trailMode} options={{ pips: 'pips', price: 'price' }} onChange={setTrailMode} />}>Trail distance ({trailMode})</FieldHead>
            <NumberInput label={`Trail distance (${trailMode})`} hideLabel value={trailInput} onValueChange={setTrailInput} precision={trailMode === 'pips' ? 1 : precision} step={trailMode === 'pips' ? '1' : tick} min="0" data-testid="ticket-trail" hint={trailAmount ? `= ${trailAmount} in price` : undefined} />
          </div>
        ) : null}
        {type === 'oco'
          ? legs.map((leg, i) => (
              <fieldset key={i} className="tk-leg col-span-2" data-testid={`oco-leg-${i}`}>
                <legend className="k-label">
                  Leg {i + 1}{' '}
                  <select
                    className="tk-mode"
                    aria-label={`Leg ${i + 1} type`}
                    value={leg.type}
                    onChange={(e) => setLegs((ls) => ls.map((l, j) => (j === i ? { ...l, type: e.target.value as OcoLegInput['type'] } : l)) as [OcoLegInput, OcoLegInput])}
                  >
                    <option value="limit">limit</option>
                    <option value="stop">stop</option>
                    <option value="stop_limit">stop-limit</option>
                  </select>
                </legend>
                <div className="grid grid-cols-2 gap-2">
                  {leg.type !== 'limit' ? (
                    <NumberInput label={`Leg ${i + 1} stop price`} value={leg.stopPrice} onValueChange={(v) => setLegs((ls) => ls.map((l, j) => (j === i ? { ...l, stopPrice: v } : l)) as [OcoLegInput, OcoLegInput])} precision={precision} step={tick} min="0" />
                  ) : null}
                  {leg.type !== 'stop' ? (
                    <NumberInput label={`Leg ${i + 1} limit price`} value={leg.limitPrice} onValueChange={(v) => setLegs((ls) => ls.map((l, j) => (j === i ? { ...l, limitPrice: v } : l)) as [OcoLegInput, OcoLegInput])} precision={precision} step={tick} min="0" />
                  ) : null}
                </div>
              </fieldset>
            ))
          : null}
        {type !== 'oco' ? (
          <>
            <div>
              <FieldHead mode={<ModeSelect label="Stop loss unit" value={slMode} options={DIST_LABEL} onChange={(m) => { setSlMode(m); setSlInput(''); }} testId="ticket-sl-mode" />}>Stop loss ({DIST_LABEL[slMode]})</FieldHead>
              <NumberInput label={`Stop loss (${DIST_LABEL[slMode]})`} hideLabel value={slInput} onValueChange={setSlInput} precision={distPrecision(slMode)} step={slMode === 'price' ? tick : '1'} min="0" placeholder="—" disabled={reduceOnly} data-testid="ticket-sl" hint={slPrice && slMode !== 'price' ? `= ${formatPrice(slPrice.toFixed(), precision)}` : undefined} />
            </div>
            <div>
              <FieldHead mode={<ModeSelect label="Take profit unit" value={tpMode} options={DIST_LABEL} onChange={(m) => { setTpMode(m); setTpInput(''); }} testId="ticket-tp-mode" />}>Take profit ({DIST_LABEL[tpMode]})</FieldHead>
              <NumberInput label={`Take profit (${DIST_LABEL[tpMode]})`} hideLabel value={tpInput} onValueChange={setTpInput} precision={distPrecision(tpMode)} step={tpMode === 'price' ? tick : '1'} min="0" placeholder="—" disabled={reduceOnly} data-testid="ticket-tp" hint={tpPrice && tpMode !== 'price' ? `= ${formatPrice(tpPrice.toFixed(), precision)}` : undefined} />
            </div>
          </>
        ) : null}
        <div>
          <FieldHead>Time in force</FieldHead>
          <select className="k-select w-full" aria-label="Time in force" value={tif} onChange={(e) => setTif(e.target.value as TimeInForce)} data-testid="ticket-tif">
            <option value="gtc">GTC</option>
            <option value="day">Day</option>
            <option value="ioc">IOC</option>
            <option value="fok">FOK</option>
            <option value="gtd">GTD</option>
          </select>
        </div>
        <div className="tk-check">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={reduceOnly} onChange={(e) => setReduceOnly(e.target.checked)} data-testid="ticket-reduce-only" /> Reduce-only
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={postOnly} onChange={(e) => setPostOnly(e.target.checked)} data-testid="ticket-post-only" /> Post-only
          </label>
        </div>
        {tif === 'gtd' ? (
          <label className="col-span-2 flex flex-col gap-1 text-xs">
            <span className="k-label">Good till (your local time)</span>
            <input type="datetime-local" className="k-input" value={expireAt} onChange={(e) => setExpireAt(e.target.value)} />
          </label>
        ) : null}
      </div>
      <dl className="tk-preview" data-testid="ticket-preview" aria-live="polite">
        <dt>Notional</dt>
        <dd data-testid="preview-notional">{p ? formatMoney(p.notional.base, ccy) : '—'}</dd>
        <dt>Est. fees + spread</dt>
        <dd data-testid="preview-fees">{p ? formatMoney(p.fees.total, ccy) : '—'}</dd>
        {p?.fx ? (
          <>
            <dt>
              FX {p.fx.from}→{p.fx.to}
            </dt>
            <dd data-testid="preview-fx">
              {p.fx.rate} · {formatMoney(p.fx.conversionCost, ccy)}
            </dd>
          </>
        ) : null}
        <dt>Margin impact{marginRatio ? ` (${marginRatio})` : ''}</dt>
        <dd data-testid="preview-margin">{p ? formatMoney(p.margin.required, ccy) : '—'}</dd>
        <dt>Loss if stop hit</dt>
        <dd data-testid="preview-loss" className={p?.lossIfStopHit ? 'k-dir--down' : ''}>
          {p?.lossIfStopHit ? `−${formatMoney(p.lossIfStopHit.total, ccy)} · ${p.lossIfStopHit.pctEquity}% eq.` : p ? 'No stop: not capped' : '—'}
        </dd>
        <dt>Reward : risk</dt>
        <dd data-testid="preview-rr">{p?.rewardRisk ? `1 : ${p.rewardRisk}` : '—'}</dd>
      </dl>
      {warnings.length || violations.length || previewError ? (
        <ul className="tk-warn" data-testid="ticket-warnings">
          {violations.map((v) => (
            <li key={v.code} className="k-error" data-testid="preview-violation">
              <strong>{v.code}</strong>: {v.message}
            </li>
          ))}
          {warnings.map((w) => (
            <li key={w.code} data-code={w.code}>
              <span aria-hidden="true">⚠ </span>
              {w.message}
            </li>
          ))}
          {previewError ? <li className="k-error">{previewError}</li> : null}
        </ul>
      ) : null}
      <p className="tk-foot">PAPER · simulated fills. Fees are SIMULATED placeholders{preview?.instrument.feesSimulated === false ? '' : ' (pending broker schedule)'}.</p>
      <div className="tk-submit">
        <Button variant={side === 'buy' ? 'buy' : 'sell'} block disabled={!canSubmit} onClick={review} data-testid="place-order" aria-keyshortcuts="Control+Enter">
          Review {side === 'buy' ? 'Buy' : 'Sell'} {qtyLabel} {displayName}
        </Button>
        {result ? (
          <p className={`m-0 text-xs ${result.tone === 'error' ? 'k-error' : ''}`} role="status" data-testid="ticket-result">
            {result.text}
          </p>
        ) : null}
      </div>
      <Dialog open={confirm} onOpenChange={setConfirm} title={`Confirm ${side} ${qtyLabel} ${displayName}`} description="Paper order with simulated market data. Esc to go back." data-testid="confirm-order">
        {p ? (
          <ul className="m-0 pl-4 text-sm">
            {p.confirmation.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
            <li>
              Notional {formatMoney(p.notional.base, ccy)}; fees + spread {formatMoney(p.fees.total, ccy)}; margin {formatMoney(p.margin.required, ccy)}
              {p.lossIfStopHit ? `; loss if the stop is hit −${formatMoney(p.lossIfStopHit.total, ccy)}` : '; no stop loss'}.
            </li>
          </ul>
        ) : null}
        <div className="k-dialog__actions">
          <Button onClick={() => setConfirm(false)}>Back</Button>
          {isMarketLike ? (
            <HoldToConfirmButton variant={side === 'buy' ? 'buy' : 'sell'} holdMs={MARKET_HOLD_MS} onConfirm={() => void place()} disabled={busy} description="Market order above your confirmation threshold." data-testid="confirm-hold">
              Hold to place
            </HoldToConfirmButton>
          ) : (
            <Button variant="primary" onClick={() => void place()} disabled={busy} data-testid="confirm-place" autoFocus>
              Place order
            </Button>
          )}
        </div>
      </Dialog>
    </div>
  );
}
