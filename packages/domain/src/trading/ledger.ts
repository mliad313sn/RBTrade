import { Decimal } from '../decimal.js';
import { ZERO } from './money.js';

/**
 * Double-entry ledger (goal 03 §1). Signed amounts: positive = debit, negative = credit. Every
 * journal sums to zero; the database refuses an unbalanced journal with a deferred trigger.
 *
 * Accounts: `cash` (the customer's balance, an asset), `capital` (deposits), `pnl` (the paper
 * counterparty's P&L), `fees` (commission income), `swap` (overnight funding), `fx` (conversion fees).
 */
export const LEDGER_ACCOUNTS = ['cash', 'capital', 'pnl', 'fees', 'swap', 'fx'] as const;
export type LedgerAccount = (typeof LEDGER_ACCOUNTS)[number];

export const JOURNAL_KINDS = ['deposit', 'fill', 'swap', 'adjustment'] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];

export interface LedgerLine {
  account: LedgerAccount;
  amount: Decimal;
}

export interface Journal {
  kind: JournalKind;
  currency: string;
  lines: LedgerLine[];
}

export class UnbalancedJournalError extends Error {}

/**
 * Ledger amounts are exact decimals quantised to 10 places (far below any currency's minor unit),
 * so sums inside the 40-digit working precision are exact and every journal balances to zero.
 */
export const LEDGER_SCALE = 10;

export function ledgerAmount(v: Decimal): Decimal {
  return v.toDecimalPlaces(LEDGER_SCALE, Decimal.ROUND_HALF_EVEN);
}

export function journalTotal(j: Pick<Journal, 'lines'>): Decimal {
  return j.lines.reduce((s, l) => s.add(l.amount), ZERO);
}

export function isBalanced(j: Pick<Journal, 'lines'>): boolean {
  return journalTotal(j).isZero();
}

function build(kind: JournalKind, currency: string, lines: LedgerLine[]): Journal {
  const j = { kind, currency, lines: lines.filter((l) => !l.amount.isZero()) };
  for (const l of j.lines)
    if (!l.amount.eq(ledgerAmount(l.amount)))
      throw new UnbalancedJournalError(`${l.account} amount exceeds ledger scale`);
  if (!isBalanced(j)) throw new UnbalancedJournalError(`unbalanced ${kind} journal`);
  return j;
}

export function depositJournal(raw: Decimal, currency: string): Journal {
  const amount = ledgerAmount(raw);
  return build('deposit', currency, [
    { account: 'cash', amount },
    { account: 'capital', amount: amount.neg() },
  ]);
}

/**
 * One journal per fill, in base currency. `realizedPnl` is signed (gain > 0); `commission` and
 * `fxConversionCost` are charges (≥ 0).
 */
export function fillJournal(p: {
  realizedPnl: Decimal;
  commission: Decimal;
  fxConversionCost: Decimal;
  currency: string;
}): Journal {
  const pnl = ledgerAmount(p.realizedPnl);
  const fees = ledgerAmount(p.commission);
  const fx = ledgerAmount(p.fxConversionCost);
  return build('fill', p.currency, [
    { account: 'cash', amount: pnl.sub(fees).sub(fx) },
    { account: 'pnl', amount: pnl.neg() },
    { account: 'fees', amount: fees },
    { account: 'fx', amount: fx },
  ]);
}

/** Overnight funding: `amount` signed from the customer's view (charge < 0, credit > 0). */
export function swapJournal(raw: Decimal, currency: string): Journal {
  const amount = ledgerAmount(raw);
  return build('swap', currency, [
    { account: 'cash', amount },
    { account: 'swap', amount: amount.neg() },
  ]);
}

/** Per-account balances; the grand total of a correct ledger is zero. */
export function trialBalance(lines: Iterable<LedgerLine>): Map<LedgerAccount, Decimal> {
  const out = new Map<LedgerAccount, Decimal>();
  for (const l of lines) out.set(l.account, (out.get(l.account) ?? ZERO).add(l.amount));
  return out;
}

export function cashBalance(lines: Iterable<LedgerLine>): Decimal {
  return trialBalance(lines).get('cash') ?? ZERO;
}
