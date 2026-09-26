'use client';

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

import { cx } from '../lib/cx';

export type ToastTone = 'info' | 'success' | 'critical';
export interface ToastItem {
  id: number;
  tone: ToastTone;
  message: ReactNode;
}

interface ToastApi {
  push: (message: ReactNode, tone?: ToastTone, ttlMs?: number) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const push = useCallback<ToastApi['push']>((message, tone = 'info', ttlMs = 6000) => {
    const id = next.current++;
    setItems((xs) => [...xs, { id, tone, message }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), ttlMs);
  }, []);
  const api = useMemo(() => ({ push }), [push]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <ToastViewport items={items} />
    </Ctx.Provider>
  );
}

export function ToastViewport({ items }: { items: ToastItem[] }) {
  const polite = items.filter((t) => t.tone !== 'critical');
  const urgent = items.filter((t) => t.tone === 'critical');
  return (
    <div className="k-toasts">
      <div role="status" aria-live="polite">
        {polite.map((t) => (
          <div key={t.id} className={cx('k-toast', `k-toast--${t.tone}`)}>
            {t.message}
          </div>
        ))}
      </div>
      <div role="alert" aria-live="assertive">
        {urgent.map((t) => (
          <div key={t.id} className="k-toast k-toast--critical">
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}

export function useToast(): ToastApi {
  const api = useContext(Ctx);
  if (!api) throw new Error('useToast must be used inside <ToastProvider>');
  return api;
}
