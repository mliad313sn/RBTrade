'use client';

import { ALERT_CONDITIONS, dec, type AlertCondition, type OrderDto, type PositionDto, type PriceAlertDto } from '@kora/domain';
import { KoraApiError, type RiskSummary } from '@kora/sdk';
import { Button, Dialog, NumberInput, formatMoney, formatPrice, useToast } from '@kora/ui';
import { useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@/lib/api-browser';
import { clockLabel, formatClock, formatQty, playFillSound } from '@/lib/terminal/format';
import { useRegistry } from '@/lib/terminal/registry';
import { useTerminal } from '@/lib/terminal/store';
import { refreshTrading, useTrading } from '@/lib/terminal/trading';

import { useTerminalSettings } from '../TerminalContext';

const cid = () => `web-${crypto.randomUUID()}`;

function errText(e: unknown): string {
  if (e instanceof KoraApiError) {
    const b = e.body as { code?: string; message?: string } | undefined;
    return b?.code ? `${b.code}: ${b.message}` : e.message;
  }
  return 'Request failed';
}

function sourceLabel(src: string | undefined): string {
  if (!src || src === 'manual') return 'Manual';
  if (src === 'ai-draft-accepted') return 'AI draft (confirmed)';
  if (src === 'kill-switch') return 'Kill switch';
  if (src.startsWith('robot:')) return `Robot · ${src.slice(6, 14)}`;
  return src;
}

function Empty({ what }: { what: string }) {
  return <p className="text-muted text-xs px-2 m-0 py-2">{what}</p>;
}

/** Protective (reduce-only, opposite side) orders per symbol → stop and target columns. */
export function protectiveLevels(orders: OrderDto[], p: Pick<PositionDto, 'symbol' | 'qty'>): { stop: OrderDto | null; target: OrderDto | null } {
  const long = !p.qty.startsWith('-');
  const exitSide = long ? 'sell' : 'buy';
  const mine = orders.filter((o) => o.symbol === p.symbol && o.side === exitSide && (o.reduceOnly || o.role === 'stop_loss' || o.role === 'take_profit' || o.role === 'oco_leg'));
  return {
    stop: mine.find((o) => (o.execType === 'stop' || o.execType === 'stop_limit' || o.execType === 'trailing') && o.stopPrice) ?? null,
    target: mine.find((o) => o.execType === 'limit' && o.limitPrice) ?? null,
  };
}

// ---- Positions ------------------------------------------------------------------------------

export function PositionsPanel() {
  const positions = useTrading((s) => s.positions);
  const orders = useTrading((s) => s.orders);
  const recent = useTrading((s) => s.recent);
  const account = useTrading((s) => s.account);
  const currency = useTrading((s) => s.currency);
  const fillSeq = useTrading((s) => s.fillSeq);
  const instruments = useRegistry((s) => s.instruments);
  const setSymbol = useTerminal((s) => s.setSymbol);
  const settings = useTerminalSettings();
  const toast = useToast();
  const [reverse, setReverse] = useState<PositionDto | null>(null);
  const [protect, setProtect] = useState<PositionDto | null>(null);
  const seenFill = useRef(fillSeq);

  // Sound on fills (Settings; off by default).
  useEffect(() => {
    if (fillSeq !== seenFill.current && settings.soundOnFills) playFillSound();
    seenFill.current = fillSeq;
  }, [fillSeq, settings.soundOnFills]);

  const sourceOf = (symbol: string) => sourceLabel(recent.find((o) => o.symbol === symbol && dec(o.filledQty).gt(0))?.source);
  const equity = account ? dec(account.equity) : null;

  const close = async (p: PositionDto) => {
    try {
      await api.closePosition(p.symbol);
      toast.push(`Closing ${p.symbol}`, 'info', 3000);
    } catch (e) {
      toast.push(`Close refused: ${errText(e)}`, 'critical');
    }
    refreshTrading();
  };
  const doReverse = async () => {
    if (!reverse) return;
    const qty = dec(reverse.qty).abs().mul(2).toFixed();
    const side = reverse.qty.startsWith('-') ? 'buy' : 'sell';
    try {
      const r = await api.placeOrder({ clientOrderId: cid(), symbol: reverse.symbol, side, type: 'market', qty });
      toast.push(`Reverse ${reverse.symbol}: order ${r.order.status}`, 'success', 4000);
    } catch (e) {
      toast.push(`Reverse refused: ${errText(e)}`, 'critical');
    }
    setReverse(null);
    refreshTrading();
  };

  return (
    <div className="bl h-full overflow-auto" data-panel-root="positions" tabIndex={-1}>
      {positions.length === 0 ? (
        <Empty what="No open positions." />
      ) : (
        <table className="k-grid" data-testid="blotter-positions">
          <thead>
            <tr>
              <th scope="col">Symbol</th>
              <th scope="col">Side</th>
              <th scope="col" className="num">Qty</th>
              <th scope="col" className="num">Avg price</th>
              <th scope="col" className="num">Mark</th>
              <th scope="col" className="num">Stop</th>
              <th scope="col" className="num">Target</th>
              <th scope="col" className="num">Unrl. P&amp;L ({currency})</th>
              <th scope="col" className="num">% Equity</th>
              <th scope="col" className="num">Source</th>
              <th scope="col" className="num">Actions</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => {
              const spec = instruments.get(p.symbol);
              const pp = spec?.pricePrecision ?? 5;
              const long = !p.qty.startsWith('-');
              const lv = protectiveLevels(orders, p);
              const pnl = p.unrealizedPnl ? dec(p.unrealizedPnl) : null;
              const pct = equity && equity.gt(0) && p.notional ? dec(p.notional).div(equity).mul(100).toDecimalPlaces(1).toFixed(1) : null;
              return (
                <tr key={p.symbol} data-testid={`pos-${p.symbol}`}>
                  <td>
                    <button type="button" className="bl-link" onClick={() => setSymbol(p.symbol)}>
                      {spec?.displayName ?? p.symbol}
                    </button>
                  </td>
                  <td className={long ? 'k-dir--up' : 'k-dir--down'}>{long ? '▲ Long' : '▼ Short'}</td>
                  <td className="num k-num">{formatQty(p.qty, spec?.qtyPrecision ?? 4)}</td>
                  <td className="num k-num">{formatPrice(p.avgPrice, pp)}</td>
                  <td className="num k-num">{p.markPrice ? formatPrice(p.markPrice, pp) : '—'}</td>
                  <td className="num k-num">{lv.stop?.stopPrice ? formatPrice(lv.stop.stopPrice, pp) : '—'}</td>
                  <td className="num k-num">{lv.target?.limitPrice ? formatPrice(lv.target.limitPrice, pp) : '—'}</td>
                  <td className={`num k-num ${pnl ? (pnl.isNegative() ? 'k-dir--down' : pnl.isZero() ? '' : 'k-dir--up') : ''}`}>
                    {p.unrealizedPnl ? formatMoney(p.unrealizedPnl, currency, { signed: true }).replace(` ${currency}`, '') : '—'}
                    {p.stale ? <span className="k-qbadge k-qbadge--stale ml-1">Stale</span> : null}
                  </td>
                  <td className="num k-num">{pct ? `${pct}%` : '—'}</td>
                  <td className="num text-ai-soft">{sourceOf(p.symbol)}</td>
                  <td className="num whitespace-nowrap">
                    <button type="button" className="bl-btn" onClick={() => setProtect(p)} data-testid={`sltp-${p.symbol}`} aria-label={`Set stop loss and take profit for ${p.symbol}`}>
                      SL/TP
                    </button>
                    <button type="button" className="bl-btn" onClick={() => setReverse(p)} data-testid={`reverse-${p.symbol}`} aria-label={`Reverse ${p.symbol}`}>
                      Reverse
                    </button>
                    <button type="button" className="bl-btn" onClick={() => void close(p)} data-testid={`close-${p.symbol}`} aria-label={`Close ${p.symbol}`}>
                      Close
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <Dialog open={reverse !== null} onOpenChange={(o) => !o && setReverse(null)} title={`Reverse ${reverse?.symbol ?? ''}?`} description="Sends a market order for twice the position size in the opposite direction (paper)." data-testid="confirm-reverse">
        <div className="k-dialog__actions">
          <Button onClick={() => setReverse(null)}>Back</Button>
          <Button variant="primary" onClick={() => void doReverse()} data-testid="confirm-reverse-ok" autoFocus>
            Reverse
          </Button>
        </div>
      </Dialog>
      {protect ? <ProtectDialog position={protect} onClose={() => setProtect(null)} /> : null}
    </div>
  );
}

/** Set SL/TP on an open position: replaces its protective orders with a reduce-only stop, target or OCO pair. */
function ProtectDialog({ position, onClose }: { position: PositionDto; onClose: () => void }) {
  const orders = useTrading((s) => s.orders);
  const spec = useRegistry((s) => s.instruments.get(position.symbol));
  const toast = useToast();
  const lv = protectiveLevels(orders, position);
  const [stop, setStop] = useState(lv.stop?.stopPrice ?? '');
  const [target, setTarget] = useState(lv.target?.limitPrice ?? '');
  const [busy, setBusy] = useState(false);
  const pp = spec?.pricePrecision ?? 5;
  const qty = dec(position.qty).abs().toFixed();
  const exit = position.qty.startsWith('-') ? 'buy' : 'sell';

  const save = async () => {
    setBusy(true);
    try {
      const existing = [lv.stop, lv.target].filter((o): o is OrderDto => o !== null);
      for (const o of existing) await api.cancelOrder(o.ocoGroup && o.parentOrderId ? o.parentOrderId : o.id).catch(() => undefined);
      if (stop && target) {
        await api.placeOrder({ clientOrderId: cid(), symbol: position.symbol, side: exit, type: 'oco', qty, reduceOnly: true, legs: [{ type: 'stop', stopPrice: stop }, { type: 'limit', limitPrice: target }] });
      } else if (stop) {
        await api.placeOrder({ clientOrderId: cid(), symbol: position.symbol, side: exit, type: 'stop', qty, stopPrice: stop, reduceOnly: true });
      } else if (target) {
        await api.placeOrder({ clientOrderId: cid(), symbol: position.symbol, side: exit, type: 'limit', qty, limitPrice: target, reduceOnly: true });
      }
      toast.push(`Protection updated for ${position.symbol}`, 'success', 3000);
      onClose();
    } catch (e) {
      toast.push(`Not saved: ${errText(e)}`, 'critical');
    } finally {
      setBusy(false);
      refreshTrading();
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Stop loss / take profit · ${spec?.displayName ?? position.symbol}`} description={`Reduce-only ${exit} orders for ${qty} (one cancels the other when both are set). Leave a field empty to remove it.`} data-testid="sltp-dialog">
      <div className="grid grid-cols-2 gap-3">
        <NumberInput label="Stop loss (price)" value={stop} onValueChange={setStop} precision={pp} step={spec?.tickSize ?? '0.00001'} min="0" data-testid="sltp-stop" />
        <NumberInput label="Take profit (price)" value={target} onValueChange={setTarget} precision={pp} step={spec?.tickSize ?? '0.00001'} min="0" data-testid="sltp-target" />
      </div>
      <div className="k-dialog__actions">
        <Button onClick={onClose}>Back</Button>
        <Button variant="primary" onClick={() => void save()} disabled={busy} data-testid="sltp-save">
          Save
        </Button>
      </div>
    </Dialog>
  );
}

// ---- Orders ----------------------------------------------------------------------------------

export function OrdersPanel() {
  const orders = useTrading((s) => s.orders);
  const instruments = useRegistry((s) => s.instruments);
  const symbol = useTerminal((s) => s.symbol);
  const { timeDisplay } = useTerminalSettings();
  const toast = useToast();
  const [editing, setEditing] = useState<{ id: string; qty: string; price: string; field: 'limitPrice' | 'stopPrice' | null } | null>(null);
  const [onlySymbol, setOnlySymbol] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const visible = useMemo(() => orders.filter((o) => o.execType !== 'none' || o.type === 'oco'), [orders]);

  const cancel = async (o: OrderDto) => {
    try {
      await api.cancelOrder(o.id);
    } catch (e) {
      toast.push(`Cancel refused: ${errText(e)}`, 'critical');
    }
    refreshTrading();
  };
  const cancelAll = async () => {
    try {
      const r = await api.cancelAllOrders(onlySymbol ? symbol : undefined);
      toast.push(`${r.cancelled} order${r.cancelled === 1 ? '' : 's'} cancelled`, 'success', 3000);
    } catch (e) {
      toast.push(`Cancel all refused: ${errText(e)}`, 'critical');
    }
    setConfirmAll(false);
    refreshTrading();
  };
  const saveAmend = async () => {
    if (!editing) return;
    const o = orders.find((x) => x.id === editing.id);
    if (!o) return setEditing(null);
    const patch: Record<string, string> = {};
    if (editing.qty && editing.qty !== o.qty) patch.qty = editing.qty;
    if (editing.field && editing.price && editing.price !== o[editing.field]) patch[editing.field] = editing.price;
    try {
      if (Object.keys(patch).length) await api.amendOrder(o.id, patch);
      setEditing(null);
    } catch (e) {
      toast.push(`Amend refused: ${errText(e)}`, 'critical');
    }
    refreshTrading();
  };

  return (
    <div className="bl h-full overflow-auto" data-panel-root="orders" tabIndex={-1}>
      <div className="bl-toolbar">
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={onlySymbol} onChange={(e) => setOnlySymbol(e.target.checked)} /> Only {instruments.get(symbol)?.displayName ?? symbol}
        </label>
        <button type="button" className="bl-btn" disabled={visible.length === 0} onClick={() => setConfirmAll(true)} data-testid="cancel-all">
          Cancel all
        </button>
      </div>
      {visible.length === 0 ? (
        <Empty what="No working orders." />
      ) : (
        <table className="k-grid" data-testid="blotter-orders">
          <thead>
            <tr>
              <th scope="col">Time ({clockLabel(timeDisplay)})</th>
              <th scope="col">Symbol</th>
              <th scope="col">Side</th>
              <th scope="col">Type</th>
              <th scope="col" className="num">Qty</th>
              <th scope="col" className="num">Filled</th>
              <th scope="col" className="num">Price</th>
              <th scope="col">TIF</th>
              <th scope="col">Status</th>
              <th scope="col" className="num">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((o) => {
              const spec = instruments.get(o.symbol);
              const pp = spec?.pricePrecision ?? 5;
              const field: 'limitPrice' | 'stopPrice' | null = o.limitPrice ? 'limitPrice' : o.stopPrice ? 'stopPrice' : null;
              const isEditing = editing?.id === o.id;
              return (
                <tr key={o.id} data-testid={`order-row-${o.id}`}>
                  <td className="k-num">{formatClock(o.createdAt, timeDisplay)}</td>
                  <td className="font-semibold">{spec?.displayName ?? o.symbol}</td>
                  <td className={o.side === 'buy' ? 'k-dir--up' : 'k-dir--down'}>{o.side === 'buy' ? '▲ Buy' : '▼ Sell'}</td>
                  <td>
                    {o.role === 'primary' ? o.type.replace('_', '-') : o.role.replace('_', ' ')}
                    {o.reduceOnly ? ' · RO' : ''}
                  </td>
                  <td className="num k-num">
                    {isEditing ? (
                      <NumberInput label="New quantity" hideLabel value={editing.qty} onValueChange={(v) => setEditing({ ...editing, qty: v })} precision={spec?.qtyPrecision ?? 4} step={spec?.qtyStep ?? '1'} min="0" className="bl-input" data-testid="amend-qty" />
                    ) : (
                      formatQty(o.qty, spec?.qtyPrecision ?? 4)
                    )}
                  </td>
                  <td className="num k-num">{formatQty(o.filledQty, spec?.qtyPrecision ?? 4)}</td>
                  <td className="num k-num">
                    {isEditing && field ? (
                      <NumberInput label="New price" hideLabel value={editing.price} onValueChange={(v) => setEditing({ ...editing, price: v })} precision={pp} step={spec?.tickSize ?? '0.00001'} min="0" className="bl-input" data-testid="amend-price" onKeyDown={(e) => e.key === 'Enter' && void saveAmend()} />
                    ) : o.limitPrice ? (
                      formatPrice(o.limitPrice, pp)
                    ) : o.stopPrice ? (
                      `stop ${formatPrice(o.stopPrice, pp)}`
                    ) : (
                      'market'
                    )}
                  </td>
                  <td className="uppercase">{o.tif}</td>
                  <td>{o.status.replace('_', ' ')}</td>
                  <td className="num whitespace-nowrap">
                    {isEditing ? (
                      <>
                        <button type="button" className="bl-btn" onClick={() => void saveAmend()} data-testid="amend-save">
                          Save
                        </button>
                        <button type="button" className="bl-btn" onClick={() => setEditing(null)}>
                          Undo
                        </button>
                      </>
                    ) : (
                      <>
                        {o.execType !== 'none' ? (
                          <button type="button" className="bl-btn" onClick={() => setEditing({ id: o.id, qty: o.qty, price: field ? (o[field] ?? '') : '', field })} data-testid={`amend-${o.id}`} aria-label={`Amend ${o.side} ${o.symbol}`}>
                            Amend
                          </button>
                        ) : null}
                        <button type="button" className="bl-btn" onClick={() => void cancel(o)} data-testid={`cancel-${o.id}`} aria-label={`Cancel ${o.side} ${o.symbol}`}>
                          Cancel
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <Dialog open={confirmAll} onOpenChange={setConfirmAll} title={`Cancel ${onlySymbol ? `all ${symbol}` : 'all'} working orders?`} description="Each cancel goes through the engine and is recorded in the audit log." data-testid="confirm-cancel-all">
        <div className="k-dialog__actions">
          <Button onClick={() => setConfirmAll(false)}>Back</Button>
          <Button variant="danger" onClick={() => void cancelAll()} data-testid="confirm-cancel-all-ok" autoFocus>
            Cancel orders
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

// ---- Fills -----------------------------------------------------------------------------------

export function FillsPanel() {
  const fills = useTrading((s) => s.fills);
  const currency = useTrading((s) => s.currency);
  const instruments = useRegistry((s) => s.instruments);
  const { timeDisplay } = useTerminalSettings();
  return (
    <div className="bl h-full overflow-auto" data-panel-root="fills" tabIndex={-1}>
      {fills.length === 0 ? (
        <Empty what="No fills yet." />
      ) : (
        <table className="k-grid" data-testid="blotter-fills">
          <thead>
            <tr>
              <th scope="col">Time ({clockLabel(timeDisplay)})</th>
              <th scope="col">Symbol</th>
              <th scope="col">Side</th>
              <th scope="col" className="num">Qty</th>
              <th scope="col" className="num">Price</th>
              <th scope="col" className="num">Reference</th>
              <th scope="col" className="num">Slippage</th>
              <th scope="col">Liquidity</th>
              <th scope="col" className="num">Fees ({currency})</th>
              <th scope="col" className="num">Realized ({currency})</th>
            </tr>
          </thead>
          <tbody>
            {fills.map((f) => {
              const spec = instruments.get(f.symbol);
              const pp = spec?.pricePrecision ?? 5;
              const slip = dec(f.slippage);
              const fees = dec(f.commission).add(dec(f.spreadCost)).add(dec(f.fxConversionCost));
              return (
                <tr key={f.id} data-testid={`fill-${f.id}`}>
                  <td className="k-num">{formatClock(f.ts, timeDisplay)}</td>
                  <td className="font-semibold">{spec?.displayName ?? f.symbol}</td>
                  <td className={f.side === 'buy' ? 'k-dir--up' : 'k-dir--down'}>{f.side === 'buy' ? '▲ Buy' : '▼ Sell'}</td>
                  <td className="num k-num">{formatQty(f.qty, spec?.qtyPrecision ?? 4)}</td>
                  <td className="num k-num">{formatPrice(f.price, pp)}</td>
                  <td className="num k-num">{formatPrice(f.referencePrice, pp)}</td>
                  <td className={`num k-num ${slip.gt(0) ? 'k-dir--down' : slip.lt(0) ? 'k-dir--up' : ''}`} data-testid="fill-slippage" title="Adverse difference vs the reference price (negative = price improvement)">
                    {slip.isZero() ? '0' : `${slip.gt(0) ? '+' : '−'}${formatPrice(slip.abs().toFixed(), pp)}`}
                  </td>
                  <td>{f.liquidity}</td>
                  <td className="num k-num">{formatMoney(fees.toFixed(), currency).replace(` ${currency}`, '')}</td>
                  <td className="num k-num">{formatMoney(f.realizedPnl, currency, { signed: true }).replace(` ${currency}`, '')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---- Alerts ----------------------------------------------------------------------------------

const COND_LABEL: Record<AlertCondition, string> = {
  price_above: 'Price ≥',
  price_below: 'Price ≤',
  rsi_above: 'RSI(14) ≥',
  rsi_below: 'RSI(14) ≤',
};

export function AlertsPanel() {
  const symbol = useTerminal((s) => s.symbol);
  const spec = useRegistry((s) => s.instruments.get(symbol));
  const toast = useToast();
  const { timeDisplay } = useTerminalSettings();
  const [alerts, setAlerts] = useState<PriceAlertDto[]>([]);
  const [condition, setCondition] = useState<AlertCondition>('price_above');
  const [threshold, setThreshold] = useState('');
  const [timeframe, setTimeframe] = useState('15m');
  const known = useRef<Set<string> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .priceAlerts({ status: 'all', limit: 100 })
        .then((r) => {
          if (cancelled) return;
          const triggered = r.alerts.filter((a) => a.status === 'triggered');
          if (known.current) {
            for (const a of triggered) if (!known.current.has(a.id)) toast.push(`Alert: ${a.symbol} ${COND_LABEL[a.condition]} ${a.threshold} (at ${a.triggeredValue})`, 'info', 8000);
          }
          known.current = new Set(triggered.map((a) => a.id));
          setAlerts(r.alerts);
        })
        .catch(() => undefined);
    void load();
    const t = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [toast]);

  const create = async () => {
    try {
      const a = await api.createPriceAlert({ symbol, condition, threshold, ...(condition.startsWith('rsi') ? { timeframe: timeframe as '15m' } : {}) });
      setAlerts((xs) => [a, ...xs]);
      setThreshold('');
    } catch (e) {
      toast.push(`Alert not created: ${errText(e)}`, 'critical');
    }
  };
  const cancel = async (id: string) => {
    try {
      const a = await api.cancelPriceAlert(id);
      setAlerts((xs) => xs.map((x) => (x.id === id ? a : x)));
    } catch (e) {
      toast.push(errText(e), 'critical');
    }
  };
  const rsiMode = condition.startsWith('rsi');

  return (
    <div className="bl h-full overflow-auto" data-panel-root="alerts" tabIndex={-1}>
      <form
        className="bl-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
        aria-label="New alert"
      >
        <span className="text-xs font-semibold">{spec?.displayName ?? symbol}</span>
        <select className="tk-mode" aria-label="Condition" value={condition} onChange={(e) => setCondition(e.target.value as AlertCondition)} data-testid="alert-condition">
          {ALERT_CONDITIONS.map((c) => (
            <option key={c} value={c}>
              {COND_LABEL[c]}
            </option>
          ))}
        </select>
        <NumberInput label="Threshold" hideLabel value={threshold} onValueChange={setThreshold} precision={rsiMode ? 2 : (spec?.pricePrecision ?? 5)} min="0" className="bl-input" placeholder={rsiMode ? '70' : 'price'} data-testid="alert-threshold" />
        {rsiMode ? (
          <select className="tk-mode" aria-label="Timeframe" value={timeframe} onChange={(e) => setTimeframe(e.target.value)}>
            {['1m', '5m', '15m', '1h', '4h', '1D'].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        ) : null}
        <button type="submit" className="bl-btn" disabled={!threshold} data-testid="alert-create">
          Add alert
        </button>
        <span className="text-muted text-[11px]">Evaluated on the server, also when this page is closed.</span>
      </form>
      {alerts.length === 0 ? (
        <Empty what="No alerts." />
      ) : (
        <table className="k-grid" data-testid="alerts-table">
          <thead>
            <tr>
              <th scope="col">Symbol</th>
              <th scope="col">Condition</th>
              <th scope="col" className="num">Threshold</th>
              <th scope="col">Status</th>
              <th scope="col">Triggered ({clockLabel(timeDisplay)})</th>
              <th scope="col" className="num">Value</th>
              <th scope="col" className="num">Actions</th>
            </tr>
          </thead>
          <tbody>
            {alerts.map((a) => (
              <tr key={a.id} data-testid={`alert-${a.id}`}>
                <td className="font-semibold">{a.symbol}</td>
                <td>
                  {COND_LABEL[a.condition]}
                  {a.timeframe ? ` · ${a.timeframe}` : ''}
                </td>
                <td className="num k-num">{a.threshold}</td>
                <td>{a.status}</td>
                <td className="k-num">{a.triggeredAt ? formatClock(a.triggeredAt, timeDisplay) : '—'}</td>
                <td className="num k-num">{a.triggeredValue ?? '—'}</td>
                <td className="num">
                  {a.status === 'active' ? (
                    <button type="button" className="bl-btn" onClick={() => void cancel(a.id)} aria-label={`Cancel alert on ${a.symbol}`}>
                      Cancel
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---- Risk ------------------------------------------------------------------------------------

export function RiskPanel() {
  const [risk, setRisk] = useState<RiskSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const positionsKey = useTrading((s) => s.positions.map((p) => `${p.symbol}:${p.qty}`).join(','));

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .riskSummary()
        .then((r) => {
          if (cancelled) return;
          setRisk(r);
          setError(null);
        })
        .catch((e: Error) => !cancelled && setError(e.message));
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [positionsKey]);

  if (error && !risk) return <Empty what={`Risk summary unavailable: ${error}`} />;
  if (!risk) return <Empty what="Loading risk…" />;
  const ccy = risk.currency;
  const used = Math.min(100, Math.max(0, Number(risk.dailyLoss.usedPct))); // meter width only
  return (
    <div className="bl h-full overflow-auto risk-grid" data-panel-root="risk" data-testid="risk-panel" tabIndex={-1}>
      <section aria-labelledby="risk-exp">
        <h3 id="risk-exp" className="k-label">
          Net exposure by currency
        </h3>
        {risk.exposure.length === 0 ? (
          <Empty what="Flat: no currency exposure." />
        ) : (
          <table className="k-grid">
            <thead>
              <tr>
                <th scope="col">Ccy</th>
                <th scope="col" className="num">Amount</th>
                <th scope="col" className="num">In {ccy}</th>
              </tr>
            </thead>
            <tbody>
              {risk.exposure.map((e) => (
                <tr key={e.currency}>
                  <td>{e.currency}</td>
                  <td className={`num k-num ${e.amount.startsWith('-') ? 'k-dir--down' : 'k-dir--up'}`}>{`${e.amount.startsWith('-') ? '▼ ' : '▲ '}${formatMoney(e.amount, e.currency, { decimals: 2 }).replace(` ${e.currency}`, '')}`}</td>
                  <td className="num k-num">{e.amountBase ? formatMoney(e.amountBase, ccy).replace(` ${ccy}`, '') : 'n/a'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section aria-labelledby="risk-var">
        <h3 id="risk-var" className="k-label">
          VaR 95 % · 1 day · historical
        </h3>
        <p className="k-num text-lg m-0" data-testid="risk-var">
          {risk.var.value ? `${formatMoney(risk.var.value, ccy)}${risk.var.pctEquity ? ` · ${risk.var.pctEquity}% eq.` : ''}` : '—'}
        </p>
        <p className="text-muted text-[11px] m-0">
          {risk.var.note} {risk.var.observations ? `${risk.var.observations} days.` : ''} Source: {risk.source === 'api' ? 'KORA api (quant service endpoint pending)' : 'quant service'}.
        </p>
      </section>
      <section aria-labelledby="risk-corr">
        <h3 id="risk-corr" className="k-label">
          Correlation clusters (|ρ| ≥ {risk.correlation.threshold})
        </h3>
        {risk.correlation.clusters.length ? (
          <ul className="m-0 pl-4 text-xs">
            {risk.correlation.clusters.map((c) => (
              <li key={c.join()}>{c.join(' · ')}</li>
            ))}
          </ul>
        ) : (
          <Empty what={risk.correlation.symbols.length > 1 ? 'No strongly correlated positions.' : 'Needs two or more positions.'} />
        )}
      </section>
      <section aria-labelledby="risk-loss">
        <h3 id="risk-loss" className="k-label">
          Daily loss vs limit
        </h3>
        <div className="flex items-center gap-2">
          <span className="inline-block w-32 h-1.5 rounded bg-raised overflow-hidden" role="meter" aria-label="Daily loss limit used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={used}>
            <span className="block h-full bg-warn" style={{ width: `${used}%` }} />
          </span>
          <span className="k-num text-xs">
            {risk.dailyLoss.usedPct}% of {formatMoney(risk.dailyLoss.limit, ccy)} · day P&amp;L {formatMoney(risk.dailyLoss.dayPnl, ccy, { signed: true })}
          </span>
        </div>
      </section>
      <p className="text-muted text-[11px] m-0 col-span-full">Estimates on SIMULATED history; not a guarantee of future losses.</p>
    </div>
  );
}

/** Blotter summary for the tab bar ("Unrealized … · Realized today …"). */
export function BlotterSummary() {
  const account = useTrading((s) => s.account);
  const fills = useTrading((s) => s.fills);
  const currency = useTrading((s) => s.currency);
  const today = new Date().toISOString().slice(0, 10);
  const realized = fills.filter((f) => f.ts.startsWith(today)).reduce((a, f) => a.add(dec(f.realizedPnl)), dec(0));
  if (!account) return null;
  const u = dec(account.unrealizedPnl);
  return (
    <span className="bl-summary k-num" data-testid="blotter-summary">
      <span className="text-muted">Unrealized</span> <span className={u.isNegative() ? 'k-dir--down' : u.isZero() ? '' : 'k-dir--up'}>{formatMoney(account.unrealizedPnl, currency, { signed: true }).replace(` ${currency}`, '')}</span>
      <span className="text-muted"> · Realized today</span> <span className={realized.isNegative() ? 'k-dir--down' : realized.isZero() ? '' : 'k-dir--up'}>{formatMoney(realized.toFixed(), currency, { signed: true }).replace(` ${currency}`, '')}</span>
    </span>
  );
}

