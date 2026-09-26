'use client';

import { SAFETY_NET, type NoviceDirection } from '@kora/domain';
import { KoraApiError, type NoviceAsset, type NoviceTicketResponse } from '@kora/sdk';
import { Button, Dialog, NumberInput, useToast } from '@kora/ui';
import { useEffect, useId, useRef, useState } from 'react';

import { refreshAccount } from '@/lib/account';
import { api } from '@/lib/api-browser';
import { Rich, useI18n } from '@/lib/i18n/react';
import { ExplainThis } from '@/lib/novice/explain-slot';
import {
  assetName,
  currencyWord,
  isRiskRejection,
  riskReasons,
  ticketDisplay,
} from '@/lib/novice/view';

import { reportPricesPaused, usePricesPaused } from './Pwa';

type TicketState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; ticket: NoviceTicketResponse }
  | { status: 'error' };

const DEBOUNCE_MS = 300;

/**
 * Novice "Make a trade" (goal 08 §3, B-306): what, which way, how much, a safety net that is always
 * on, and the most you could lose (fees included) from the server's preview before anything
 * happens. The review sheet repeats the numbers and needs an explicit "I understand" tick.
 */
export function TradeCard({
  assets,
  currency,
  initialSymbol,
  coolingOff,
  onPlaced,
}: {
  assets: NoviceAsset[];
  currency: string;
  initialSymbol: string;
  coolingOff: boolean;
  onPlaced: () => void;
}) {
  const { t, locale, money, dateTime } = useI18n();
  const toast = useToast();
  const paused = usePricesPaused();
  const safetyId = useId();
  const [symbol, setSymbol] = useState(
    assets.some((a) => a.symbol === initialSymbol)
      ? initialSymbol
      : (assets[0]?.symbol ?? initialSymbol),
  );
  const [direction, setDirection] = useState<NoviceDirection | null>(null);
  const [amount, setAmount] = useState('500');
  const [safety, setSafety] = useState(String(SAFETY_NET.default));
  const [state, setState] = useState<TicketState>({ status: 'idle' });
  const [review, setReview] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [placeError, setPlaceError] = useState<string[] | null>(null);
  const [allAssets, setAllAssets] = useState(false);
  const seq = useRef(0);

  const asset = assets.find((a) => a.symbol === symbol);
  const name = asset ? assetName(asset.name, locale, asset.displayName) : symbol;

  useEffect(() => {
    if (!direction || !amount || Number(amount) <= 0) {
      setState({ status: 'idle' });
      return;
    }
    const my = ++seq.current;
    setState({ status: 'loading' });
    const timer = setTimeout(() => {
      api
        .noviceTicket({ symbol, direction, amount, safetyNetPct: safety })
        .then((ticket) => {
          if (my !== seq.current) return;
          setState({ status: 'done', ticket });
          reportPricesPaused(false);
        })
        .catch((e: unknown) => {
          if (my !== seq.current) return;
          if (e instanceof TypeError) reportPricesPaused(true);
          setState({ status: 'error' });
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [symbol, direction, amount, safety]);

  const ticket = state.status === 'done' ? state.ticket : null;
  const shown = ticketDisplay(ticket, locale);
  const blocked = ticket?.ok ? riskReasons(ticket.preview.risk.violations, t) : [];
  const canReview =
    !!shown && ticket?.ok === true && blocked.length === 0 && !paused && !coolingOff;

  const place = async () => {
    if (!ticket?.ok) return;
    setPlacing(true);
    setPlaceError(null);
    try {
      await api.placeOrder({ ...ticket.order, clientOrderId: crypto.randomUUID() });
      toast.push(t('review.done'), 'success', 6000);
      setReview(false);
      setUnderstood(false);
      refreshAccount();
      onPlaced();
    } catch (e) {
      if (e instanceof KoraApiError && isRiskRejection(e.body))
        setPlaceError(riskReasons(e.body.violations, t));
      else setPlaceError([t('common.error')]);
    } finally {
      setPlacing(false);
    }
  };

  return (
    <section className="k-panel" aria-labelledby="trade-title" data-testid="novice-trade">
      <div className="k-panel__body flex flex-col gap-4">
        <div>
          <h2 id="trade-title" className="font-display text-[28px] m-0 leading-tight">
            {t('trade.title')}
          </h2>
          <p className="m-0 mt-1 text-muted">{t('trade.subtitle')}</p>
        </div>

        <fieldset className="border-0 p-0 m-0">
          <legend className="font-semibold mb-2">{t('trade.step1')}</legend>
          <div className="flex flex-wrap gap-2" data-testid="asset-list">
            {assets
              .filter((a, i) => allAssets || i < 4 || a.symbol === symbol)
              .map((a) => {
                const n = assetName(a.name, locale, a.displayName);
                const closed = a.session !== 'open';
                return (
                  <button
                    key={a.symbol}
                    type="button"
                    aria-pressed={symbol === a.symbol}
                    onClick={() => setSymbol(a.symbol)}
                    className={`k-btn ${symbol === a.symbol ? 'k-btn--primary' : ''}`}
                    data-symbol={a.symbol}
                  >
                    {n}
                    {closed ? (
                      <span className="text-xs font-normal opacity-80">· {t('trade.closed')}</span>
                    ) : null}
                  </button>
                );
              })}
            {assets.length > 4 ? (
              <button
                type="button"
                className="k-btn k-btn--ghost"
                aria-expanded={allAssets}
                onClick={() => setAllAssets((v) => !v)}
                data-testid="more-assets"
              >
                {allAssets ? t('trade.fewer') : t('trade.more', { n: assets.length - 4 })}
              </button>
            ) : null}
          </div>
          {asset && asset.session !== 'open' && asset.nextChange ? (
            <p className="m-0 mt-2 text-sm text-muted" data-testid="market-closed">
              {t('trade.closedNote', { name, when: dateTime(asset.nextChange) })}
            </p>
          ) : null}
        </fieldset>

        <fieldset className="border-0 p-0 m-0">
          <legend className="font-semibold mb-2">{t('trade.step2')}</legend>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <button
              type="button"
              aria-pressed={direction === 'up'}
              onClick={() => setDirection('up')}
              className={`k-btn min-h-14! ${direction === 'up' ? 'bg-up-surface! text-up! border-up!' : ''}`}
              data-testid="direction-up"
            >
              <span aria-hidden="true">▲</span> {t('trade.up')}
            </button>
            <button
              type="button"
              aria-pressed={direction === 'down'}
              onClick={() => setDirection('down')}
              className={`k-btn min-h-14! ${direction === 'down' ? 'bg-down-surface! text-down! border-down!' : ''}`}
              data-testid="direction-down"
            >
              <span aria-hidden="true">▼</span> {t('trade.down')}
            </button>
          </div>
        </fieldset>

        <div>
          <NumberInput
            label={t('trade.step3', { ccy: currencyWord(currency, t) })}
            value={amount}
            onValueChange={setAmount}
            precision={2}
            min="0"
            step="100"
            data-testid="trade-amount"
          />
          {ticket && !ticket.ok && ticket.reason === 'amount_too_small' && ticket.minAmount ? (
            <p className="m-0 mt-2 text-sm" role="status" data-testid="amount-min">
              {t('trade.min', { name, amount: money(ticket.minAmount, currency) })}
            </p>
          ) : null}
        </div>

        <div className="p-4 rounded-xl bg-raised border border-border" data-testid="safety-net">
          <label htmlFor={safetyId} className="font-semibold block">
            {t(direction === 'down' ? 'trade.safety.down' : 'trade.safety.up', {
              pct: safety.replace('.', locale === 'fr' ? ',' : '.'),
            })}
          </label>
          <input
            id={safetyId}
            type="range"
            min={SAFETY_NET.min}
            max={SAFETY_NET.max}
            step={SAFETY_NET.step}
            value={safety}
            onChange={(e) => setSafety(e.target.value)}
            className="w-full h-11 accent-[var(--k-accent)] cursor-pointer"
            data-testid="safety-slider"
          />
          <div className="flex items-end justify-between gap-3 mt-2">
            <span className="text-muted">{t('trade.most')}</span>
            <span
              className="font-display text-[28px] text-down leading-none"
              data-testid="most-you-could-lose"
              aria-live="polite"
            >
              {shown ? shown.mostYouCouldLose : '—'}
            </span>
          </div>
          <p className="m-0 mt-1 text-sm text-muted" data-testid="ticket-note">
            {shown
              ? t('trade.fees', { fees: shown.fees })
              : state.status === 'loading'
                ? t('trade.working')
                : ticket && !ticket.ok && ticket.reason !== 'amount_too_small'
                  ? t('trade.noPrice')
                  : state.status === 'error'
                    ? t('trade.noPrice')
                    : t('trade.pick')}
          </p>
          {shown ? (
            <ExplainThis
              topic="most_you_could_lose"
              locale={locale}
              context={{
                symbol,
                currency,
                loss: shown.raw.mostYouCouldLose,
                fees: shown.raw.fees,
                safetyNetPct: safety,
              }}
            />
          ) : null}
        </div>

        {blocked.length ? (
          <div className="text-sm" role="status" data-testid="trade-blocked">
            <p className="m-0 font-semibold">{t('trade.blocked')}</p>
            <ul className="m-0 pl-5">
              {blocked.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <Button
          variant="primary"
          size="lg"
          block
          className="min-h-14!"
          disabled={!canReview}
          onClick={() => setReview(true)}
          data-testid="review-trade"
        >
          {t('trade.review')}
        </Button>
      </div>

      <Dialog
        open={review && !!shown && !!ticket?.ok}
        onOpenChange={(o) => {
          setReview(o);
          if (!o) {
            setUnderstood(false);
            setPlaceError(null);
          }
        }}
        title={t('review.title')}
        description={t('review.practice')}
        data-testid="review-sheet"
      >
        {shown && ticket?.ok ? (
          <div className="flex flex-col gap-3">
            <p className="m-0">
              {t(direction === 'down' ? 'review.down' : 'review.up', {
                name,
                amount: money(ticket.amountUsed, currency),
              })}
            </p>
            <ul className="m-0 pl-5 flex flex-col gap-1">
              <li data-testid="review-loss">
                <Rich text={t('review.loss', { loss: shown.mostYouCouldLose })} />
              </li>
              <li data-testid="review-gain">
                <Rich text={t('review.gain', { gain: shown.gain })} />
              </li>
              <li>{t('review.fees', { fees: shown.fees })}</li>
            </ul>
            <p className="m-0 text-sm text-muted">{t('review.gap')}</p>
            <label className="flex items-start gap-3 min-h-11 cursor-pointer">
              <input
                type="checkbox"
                className="w-6 h-6 mt-0.5 accent-[var(--k-accent)] shrink-0"
                checked={understood}
                onChange={(e) => setUnderstood(e.target.checked)}
                data-testid="understand"
              />
              <span className="font-semibold">
                {t('review.check', { loss: shown.mostYouCouldLose })}
              </span>
            </label>
            {placeError ? (
              <div role="alert" className="k-error text-sm" data-testid="place-error">
                <p className="m-0 font-semibold">{t('review.failed')}</p>
                <ul className="m-0 pl-5">
                  {placeError.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="k-dialog__actions">
              <Button onClick={() => setReview(false)}>{t('review.back')}</Button>
              <Button
                variant="primary"
                disabled={!understood || placing}
                onClick={() => void place()}
                data-testid="confirm-trade"
              >
                {t('review.confirm')}
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </section>
  );
}
