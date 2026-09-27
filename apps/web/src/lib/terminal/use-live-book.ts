'use client';

import type { AccountView } from '@kora/sdk';
import { useEffect, useMemo, useState } from 'react';

import { useAccountSnapshot } from '@/lib/account';

import { liveAccount, markPositions, newerAccount, type MarkedPosition } from './live-book';
import { useLiveQuotes, useTrading } from './trading';

/**
 * One source of truth for positions and account figures on Pro screens (IRTC R5-02, R5-06): the newest
 * engine snapshot (REST poll or `account:` push), repriced from the live quotes while a terminal is
 * streaming. The top bar, the blotter rows and the blotter summary all read this hook.
 */
export function useLiveBook(): {
  positions: MarkedPosition[];
  account: AccountView | null;
  live: boolean;
} {
  const positions = useTrading((s) => s.positions);
  const positionsAt = useTrading((s) => s.positionsAt);
  const streaming = useTrading((s) => s.streaming);
  const pushed = useTrading((s) => s.account);
  const polled = useAccountSnapshot((s) => s.account);
  const quotes = useLiveQuotes((s) => s.quotes);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const base = newerAccount(polled, streaming ? pushed : null);
  const currency = base?.baseCurrency ?? 'USD';
  const marked = useMemo(
    () => markPositions(positions, streaming ? quotes : new Map(), { now, positionsAt, currency }),
    [positions, quotes, streaming, now, positionsAt, currency],
  );
  const account = useMemo(
    () => (base && streaming ? liveAccount(base, marked) : base),
    [base, streaming, marked],
  );
  return { positions: marked, account, live: streaming && marked.some((p) => p.live) };
}
