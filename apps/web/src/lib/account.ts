'use client';

import type { AccountView } from '@kora/sdk';
import { useCallback, useEffect } from 'react';
import { create } from 'zustand';

import { api } from './api-browser';

const REFRESH_EVENT = 'kora:account-refresh';
export const ACCOUNT_POLL_MS = 5000;

/** Ask every mounted account view to reload now (after a kill switch, an order, a resume). */
export function refreshAccount(): void {
  window.dispatchEvent(new Event(REFRESH_EVENT));
}

/**
 * The last engine snapshot of the paper account from GET /accounts/me, shared by every view (top bar,
 * halt banner, blotter summary) so they cannot disagree (IRTC R5-02). `okAt` is the client time of the
 * last successful fetch and `error` whether the latest one failed; together they drive the stale
 * marker in the top bar (IRTC R5-06).
 */
interface AccountSnapshot {
  account: AccountView | null;
  error: boolean;
  okAt: number | null;
  set: (p: Partial<Omit<AccountSnapshot, 'set'>>) => void;
}

export const useAccountSnapshot = create<AccountSnapshot>((set) => ({
  account: null,
  error: false,
  okAt: null,
  set: (p) => set(p),
}));

/** Loads the account once into the shared snapshot. */
function loadAccount(): void {
  api
    .account()
    .then((a) => useAccountSnapshot.getState().set({ account: a, error: false, okAt: Date.now() }))
    .catch(() => useAccountSnapshot.getState().set({ error: true }));
}

// One poller for every mounted view (reference counted), so the top bar and the halt banner do not
// each fetch the same account.
let subscribers = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(): () => void {
  subscribers += 1;
  if (subscribers === 1) {
    loadAccount();
    timer = setInterval(loadAccount, ACCOUNT_POLL_MS);
    window.addEventListener(REFRESH_EVENT, loadAccount);
  }
  return () => {
    subscribers -= 1;
    if (subscribers === 0) {
      if (timer) clearInterval(timer);
      timer = null;
      window.removeEventListener(REFRESH_EVENT, loadAccount);
    }
  };
}

/**
 * The paper account (GET /accounts/me): equity, day P&L, margin, loss-limit usage and halt state.
 * Polls over REST, so it keeps working when the WebSocket is down (kill switch fallback path). A failed
 * poll keeps the last figures but sets `error`, which the top bar shows as "as of hh:mm:ss".
 */
export function useAccount(): { account: AccountView | null; error: boolean; okAt: number | null; reload: () => void } {
  const account = useAccountSnapshot((s) => s.account);
  const error = useAccountSnapshot((s) => s.error);
  const okAt = useAccountSnapshot((s) => s.okAt);
  const reload = useCallback(() => loadAccount(), []);
  useEffect(() => subscribe(), []);
  return { account, error, okAt, reload };
}
