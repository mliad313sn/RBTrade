import { Panel } from '@kora/ui';
import type { ReactNode } from 'react';

/** Explicit placeholder: names the goal that delivers the screen. No invented numbers. */
export function Placeholder({ title, goal, children }: { title: string; goal: string; children?: ReactNode }) {
  return (
    <Panel title={title}>
      <p className="m-0 text-muted">
        Arrives with {goal}. Nothing on this screen uses real money or market data.
      </p>
      {children}
    </Panel>
  );
}
