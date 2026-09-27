import { act, render, screen } from '@testing-library/react';
import { useState } from 'react';

import { Dialog } from './Dialog';

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        opener
      </button>
      <Dialog open={open} onOpenChange={setOpen} title="Choose">
        <button type="button" onClick={() => setOpen(false)}>
          close
        </button>
      </Dialog>
    </>
  );
}

describe('Dialog focus return (goal 10, WCAG 2.4.3)', () => {
  it('gives focus back to the element that opened it when it closes without a trigger', async () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'opener' });
    opener.focus();
    await act(async () => opener.click());
    expect(screen.getByRole('dialog')).toBeTruthy();
    await act(async () => screen.getByRole('button', { name: 'close' }).click());
    expect(document.activeElement).toBe(opener);
  });
});
