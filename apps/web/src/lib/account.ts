'use client';

import type { AccountView } from '@kora/sdk';
import { useCallback, useEffect, useState } from 'react';

import { api } from './api-browser';

const REFRESH_EVENT = 'kora:account-refresh';
const POLL_MS = 5000;

/** Ask every mounted account view to reload now (after a kill switch, an order, a resume). */
export function refreshAccount(): void {
  window.dispatchEvent(new Event(REFRESH_EVENT));
}

/**
 * The paper account (GET /accounts/me): equity, day P&L, margin, loss-limit usage and halt state.
 * Polls over REST, so it keeps working when the WebSocket is down (kill switch fallback path).
 */
export function useAccount(): { account: AccountView | null; error: boolean; reload: () => void } {
  const [account, setAccount] = useState<AccountView | null>(null);
  const [error, setError] = useState(false);
  const reload = useCallback(() => {
    api
      .account()
      .then((a) => {
        setAccount(a);
        setError(false);
      })
      .catch(() => setError(true));
  }, []);
  useEffect(() => {
    reload();
    const t = setInterval(reload, POLL_MS);
    window.addEventListener(REFRESH_EVENT, reload);
    return () => {
      clearInterval(t);
      window.removeEventListener(REFRESH_EVENT, reload);
    };
  }, [reload]);
  return { account, error, reload };
}
