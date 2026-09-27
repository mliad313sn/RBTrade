'use client';

import type { MeResponse } from '@kora/sdk';
import { createContext, useContext, useState, type ReactNode } from 'react';

interface ShellState {
  me: MeResponse;
  setMe: (me: MeResponse) => void;
}

const Ctx = createContext<ShellState | null>(null);

export function ShellProvider({
  initialMe,
  children,
}: {
  initialMe: MeResponse;
  children: ReactNode;
}) {
  const [me, setMe] = useState(initialMe);
  // Keep in sync when the server layout re-renders after router.refresh().
  const [seen, setSeen] = useState(initialMe);
  if (seen !== initialMe) {
    setSeen(initialMe);
    setMe(initialMe);
  }
  return <Ctx.Provider value={{ me, setMe }}>{children}</Ctx.Provider>;
}

export function useShell(): ShellState {
  const s = useContext(Ctx);
  if (!s) throw new Error('useShell outside ShellProvider');
  return s;
}
