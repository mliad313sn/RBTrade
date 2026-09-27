import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { Button } from './Button';
import { Dialog } from './Dialog';

function Demo({ startOpen }: { startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open dialog</Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Confirm order"
        description="Buy 100,000 EUR/USD at 1.08421 (simulated)."
        actions={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="buy" onClick={() => setOpen(false)}>
              Confirm
            </Button>
          </>
        }
      />
    </>
  );
}

const meta = {
  title: 'Primitives/Dialog',
  component: Demo,
  args: { startOpen: true },
} satisfies Meta<typeof Demo>;
export default meta;
export const Open: StoryObj<typeof meta> = {};
export const Closed: StoryObj<typeof meta> = { args: { startOpen: false } };
