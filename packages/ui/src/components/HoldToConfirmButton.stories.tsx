import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { HoldToConfirmButton } from './HoldToConfirmButton';

function Demo({ holdMs }: { holdMs: number }) {
  const [count, setCount] = useState(0);
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      <HoldToConfirmButton holdMs={holdMs} onConfirm={() => setCount((c) => c + 1)}>
        ■ KILL SWITCH
      </HoldToConfirmButton>
      <span>Confirmed {count}×</span>
    </div>
  );
}

const meta = {
  title: 'Primitives/HoldToConfirmButton',
  component: Demo,
  args: { holdMs: 1500 },
} satisfies Meta<typeof Demo>;
export default meta;
export const KillSwitch: StoryObj<typeof meta> = {};
export const Short: StoryObj<typeof meta> = { args: { holdMs: 600 } };
