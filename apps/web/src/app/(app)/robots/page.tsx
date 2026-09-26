import { Suspense } from 'react';

import { RobotsMonitor } from '@/components/robots/RobotsMonitor';

export const metadata = { title: 'Robots' };

export default function Page() {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Loading robots…</p>}>
      <RobotsMonitor />
    </Suspense>
  );
}
