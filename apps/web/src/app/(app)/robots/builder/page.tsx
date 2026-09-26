import { Suspense } from 'react';

import { StrategyBuilder } from '@/components/robots/StrategyBuilder';

export const metadata = { title: 'Robot builder' };

export default function RobotBuilderPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Loading the builder…</p>}>
      <StrategyBuilder />
    </Suspense>
  );
}
