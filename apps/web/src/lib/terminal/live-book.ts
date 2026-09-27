import { dec, formatAmount, formatPct, type PositionDto } from '@kora/domain';
import type { AccountView } from '@kora/sdk';

/**
 * Mark-to-market of the blotter and the account from the live quote stream (IRTC R5-02, R5-06).
 *
 * The engine publishes `positions:` and `account:` only on trade events, so between trades the
 * figures it sent are frozen at the quotes of that moment. The terminal already streams quotes, so
 * the blotter rows, the blotter summary and the top bar reprice from the same quotes with the
 * engine's own rules:
 *
 *   mark      = bid for a long, ask for a short (domain `markFor`)
 *   k         = multiplier × FX rate, recovered from the engine's figures: notional / (|qty| × mark)
 *   unrealized = (mark − avg) × qty × k            exposure = |qty| × mark × k
 *   margin    = exposure × (engine margin / engine exposure)
 *   equity    = cash + Σ unrealized                 day P&L = equity − (engine equity − engine day P&L)
 *
 * FX moves between trades are ignored (k is held); the 20 s REST reconcile brings them in.
 */

export interface LiveQuote {
  bid: string;
  ask: string;
  stale: boolean;
  /** Client clock when the quote arrived (ms). */
  receivedAt: number;
}

export interface MarkedPosition extends PositionDto {
  /** Repriced from a live quote in this browser. */
  live: boolean;
  /** Mark or data is stale (engine flag, stale quote, or no update for longer than the threshold). */
  stale: boolean;
}

/** A quote or a snapshot older than this is shown as stale. */
export const LIVE_STALE_MS = 10_000;

export function markPositions(
  positions: readonly PositionDto[],
  quotes: ReadonlyMap<string, LiveQuote>,
  opts: { now: number; positionsAt: number | null; currency: string; staleMs?: number },
): MarkedPosition[] {
  const ccy = opts.currency;
  const staleMs = opts.staleMs ?? LIVE_STALE_MS;
  const snapshotOld = opts.positionsAt === null || opts.now - opts.positionsAt > staleMs;
  return positions.map((p) => {
    const q = quotes.get(p.symbol);
    const qty = dec(p.qty);
    const serverMark = p.markPrice ? dec(p.markPrice) : null;
    if (!q || !serverMark || serverMark.isZero() || !p.notional || qty.isZero()) {
      return { ...p, live: false, stale: p.stale || snapshotOld };
    }
    const k = dec(p.notional).div(qty.abs().mul(serverMark));
    const mark = dec(qty.isNegative() ? q.ask : q.bid);
    const exposure = qty.abs().mul(mark).mul(k);
    const marginRate =
      p.marginUsed && !dec(p.notional).isZero() ? dec(p.marginUsed).div(dec(p.notional)) : null;
    return {
      ...p,
      markPrice: mark.toFixed(),
      unrealizedPnl: formatAmount(mark.sub(dec(p.avgPrice)).mul(qty).mul(k), ccy),
      notional: formatAmount(exposure, ccy),
      marginUsed: marginRate ? formatAmount(exposure.mul(marginRate), ccy) : p.marginUsed,
      live: true,
      stale: q.stale || opts.now - q.receivedAt > staleMs,
    };
  });
}

/**
 * Account figures consistent with the marked positions. Falls back to the engine's view when the
 * two snapshots do not describe the same book (a trade is in flight) or a position cannot be priced.
 */
export function liveAccount(account: AccountView, marked: readonly MarkedPosition[]): AccountView {
  if (!marked.some((p) => p.live)) return account;
  if (account.openPositions !== marked.length || marked.some((p) => p.unrealizedPnl === null))
    return account;
  const ccy = account.baseCurrency;
  const unrealized = marked.reduce((a, p) => a.add(dec(p.unrealizedPnl!)), dec(0));
  // Margin per position is optional on the wire; without it for every position keep the engine's total.
  const margin = marked.every((p) => p.marginUsed !== null)
    ? marked.reduce((a, p) => a.add(dec(p.marginUsed!)), dec(0))
    : dec(account.marginUsed);
  const equity = dec(account.cash).add(unrealized);
  const dayStart = dec(account.equity).sub(dec(account.dayPnl));
  const dayPnl = equity.sub(dayStart);
  const limit = dec(account.dailyLossLimit);
  return {
    ...account,
    equity: formatAmount(equity, ccy),
    unrealizedPnl: formatAmount(unrealized, ccy),
    dayPnl: formatAmount(dayPnl, ccy),
    marginUsed: formatAmount(margin, ccy),
    marginFree: formatAmount(equity.sub(margin), ccy),
    marginUsedPct: equity.gt(0) ? formatPct(margin.div(equity)) : account.marginUsedPct,
    dailyLossUsedPct: limit.gt(0)
      ? formatPct((dayPnl.isNegative() ? dayPnl.neg() : dec(0)).div(limit))
      : account.dailyLossUsedPct,
  };
}

/** The newer of two engine snapshots of the account (REST poll vs `account:` push), by server `asOf`. */
export function newerAccount(a: AccountView | null, b: AccountView | null): AccountView | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b.asOf) > Date.parse(a.asOf) ? b : a;
}

/** Top-bar stale state: the last account request failed, or the last good snapshot is too old. */
export function accountStale(
  s: { error: boolean; okAt: number | null },
  now: number,
  staleMs = LIVE_STALE_MS,
): boolean {
  return s.error || s.okAt === null || now - s.okAt > staleMs;
}
