'use client';

import dynamic from 'next/dynamic';

import type { AiStripMode } from '@/lib/terminal/ai-strip';

/** The dockable terminal is client-only (dockview and the canvas chart need the DOM). */
const ProTerminal = dynamic(() => import('./Terminal'), {
  ssr: false,
  loading: () => <div className="k-dock-skeleton h-full" aria-busy="true" aria-label="Loading the terminal" />,
});

export function TerminalLoader(props: { initialSymbol: string; wsPort: string; aiStrip: AiStripMode }) {
  return <ProTerminal {...props} />;
}
