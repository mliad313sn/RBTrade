'use client';

import { formatMoney } from '@kora/ui';

import { useAccount } from '@/lib/account';

/** Novice home: practice balance from the paper engine (plain words, symbol display). */
export function PracticeBalance() {
  const { account } = useAccount();
  if (!account) {
    return (
      <p className="font-display text-5xl m-0" aria-label="Balance loading">
        —
      </p>
    );
  }
  return (
    <>
      <p className="font-display text-5xl m-0" data-testid="practice-balance">
        {formatMoney(account.equity, account.baseCurrency, { display: 'symbol' })}
      </p>
      <p className="text-muted">
        Practice money. Today: {formatMoney(account.dayPnl, account.baseCurrency, { display: 'symbol', signed: true })}.
      </p>
    </>
  );
}
