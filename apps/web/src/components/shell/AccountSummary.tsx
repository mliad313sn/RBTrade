'use client';

import { dec } from '@kora/domain';
import { formatMoney } from '@kora/ui';

import { useAccount } from '@/lib/account';

/**
 * Top-bar account figures from the paper engine (GET /accounts/me): equity, day P&L, margin used
 * and daily loss-limit usage. Colour is never the only cue (▲▼ and +/− are always shown).
 */
export function AccountSummary() {
  const { account } = useAccount();
  const ccy = account?.baseCurrency ?? 'USD';
  const day = account ? dec(account.dayPnl) : null;
  const arrow = !day || day.isZero() ? '' : day.isNegative() ? '▼ ' : '▲ ';
  const dir = !day || day.isZero() ? 'flat' : day.isNegative() ? 'down' : 'up';
  const usedPct = account ? Math.min(100, Math.max(0, Number(account.dailyLossUsedPct))) : 0; // display width only
  return (
    <dl className="hidden xl:flex items-center gap-6 m-0" aria-label="Paper account summary" data-testid="account-summary">
      <div className="flex flex-col">
        <dt className="text-[10px] uppercase tracking-wider text-muted">Equity</dt>
        <dd className="m-0 k-num text-sm" data-testid="account-equity">
          {account ? formatMoney(account.equity, ccy, { display: 'code' }) : '—'}
        </dd>
      </div>
      <div className="flex flex-col">
        <dt className="text-[10px] uppercase tracking-wider text-muted">Day P&amp;L</dt>
        <dd className={`m-0 k-num text-sm k-dir--${dir}`} data-testid="account-day-pnl">
          {account ? `${arrow}${formatMoney(account.dayPnl, ccy, { signed: true })}` : '—'}
        </dd>
      </div>
      <div className="flex flex-col">
        <dt className="text-[10px] uppercase tracking-wider text-muted">Margin used</dt>
        <dd className="m-0 k-num text-sm" data-testid="account-margin">
          {account ? `${formatMoney(account.marginUsed, ccy)} · ${account.marginUsedPct}%` : '—'}
        </dd>
      </div>
      <div className="flex flex-col">
        <dt className="text-[10px] uppercase tracking-wider text-muted">Daily loss limit</dt>
        <dd className="m-0 flex items-center gap-2 text-sm" data-testid="account-loss-limit">
          <span
            className="inline-block w-28 h-1.5 rounded bg-raised overflow-hidden"
            role="meter"
            aria-label="Daily loss limit used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={usedPct}
          >
            <span className="block h-full bg-warn" style={{ width: `${usedPct}%` }} />
          </span>
          <span className="k-num text-xs">{account ? `${account.dailyLossUsedPct}%` : '—'}</span>
        </dd>
      </div>
    </dl>
  );
}
