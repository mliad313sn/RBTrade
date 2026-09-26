import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { SegmentedControl } from './SegmentedControl';

function Demo() {
  const [v, setV] = useState<'pro' | 'novice'>('pro');
  return (
    <SegmentedControl
      label="View mode"
      value={v}
      onChange={setV}
      options={[
        { value: 'pro', label: 'Pro' },
        { value: 'novice', label: 'Novice' },
      ]}
    />
  );
}

const meta = { title: 'Primitives/SegmentedControl', component: Demo } satisfies Meta<typeof Demo>;
export default meta;
export const ViewMode: StoryObj<typeof meta> = {};
