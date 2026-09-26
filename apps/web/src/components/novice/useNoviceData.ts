'use client';

import type { AutoInvestList, NoviceAsset, NoviceProfile, NoviceSummary } from '@kora/sdk';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/lib/api-browser';

import { reportPricesPaused } from './Pwa';

export interface NoviceData {
  profile: NoviceProfile | null;
  summary: NoviceSummary | null;
  assets: { currency: string; assets: NoviceAsset[] } | null;
  autoInvest: AutoInvestList | null;
}

const POLL_MS = 5000;
const REFRESH_EVENT = 'kora:account-refresh';

/**
 * Home data: server-rendered first (fast first paint), then refreshed over REST every 5 s and after
 * any trade, kill switch or limit change. A failed refresh marks prices as paused (offline shell).
 */
export function useNoviceData(initial: NoviceData) {
  const [data, setData] = useState<NoviceData>(initial);
  const alive = useRef(true);
  const reload = useCallback(async () => {
    try {
      const [profile, summary] = await Promise.all([api.noviceProfile(), api.noviceSummary()]);
      if (!alive.current) return;
      setData((d) => ({ ...d, profile, summary }));
      reportPricesPaused(false);
    } catch (e) {
      if (e instanceof TypeError) reportPricesPaused(true); // network failure, not an API error
    }
  }, []);
  const reloadAutoInvest = useCallback(async () => {
    try {
      const autoInvest = await api.autoInvest();
      if (alive.current) setData((d) => ({ ...d, autoInvest }));
    } catch {
      /* keep the last list */
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    const t = setInterval(() => void reload(), POLL_MS);
    const onRefresh = () => void reload();
    window.addEventListener(REFRESH_EVENT, onRefresh);
    return () => {
      alive.current = false;
      clearInterval(t);
      window.removeEventListener(REFRESH_EVENT, onRefresh);
    };
  }, [reload]);
  return { data, reload, reloadAutoInvest };
}
