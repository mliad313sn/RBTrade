import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HoldToConfirmButton } from './HoldToConfirmButton';

/**
 * IRTC R5-04: screen readers, voice control and switch access activate a button with a single
 * `click` (no pointer hold). A tap on a phone is the same. Such an activation must open an explicit
 * confirm step instead of doing nothing; the strings must be localisable.
 */
describe('HoldToConfirmButton accessible alternative (IRTC R5-04)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('an assistive-technology click (detail 0) opens a confirm dialog; Confirm runs onConfirm once', () => {
    const onConfirm = vi.fn();
    render(
      <HoldToConfirmButton onConfirm={onConfirm} confirmTitle="Halt every robot?">
        Halt all
      </HoldToConfirmButton>,
    );
    const btn = screen.getByRole('button', { name: 'Halt all' });
    act(() => btn.click());
    expect(onConfirm).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog', { name: 'Halt every robot?' });
    expect(dialog).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('a short tap opens the confirm step (visible feedback); Cancel does nothing', () => {
    const onConfirm = vi.fn();
    render(<HoldToConfirmButton onConfirm={onConfirm}>Stop everything</HoldToConfirmButton>);
    const btn = screen.getByRole('button', { name: 'Stop everything' });
    fireEvent.pointerDown(btn, { button: 0, pointerId: 1 });
    act(() => vi.advanceTimersByTime(120));
    fireEvent.pointerUp(btn);
    fireEvent.click(btn, { detail: 1 });
    expect(screen.getByRole('alertdialog')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    act(() => vi.advanceTimersByTime(3000));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('the click that ends a completed hold does not open the dialog or confirm twice', () => {
    const onConfirm = vi.fn();
    render(<HoldToConfirmButton onConfirm={onConfirm}>Kill</HoldToConfirmButton>);
    const btn = screen.getByRole('button', { name: 'Kill' });
    fireEvent.pointerDown(btn, { button: 0, pointerId: 1 });
    act(() => vi.advanceTimersByTime(1500));
    fireEvent.pointerUp(btn);
    fireEvent.click(btn, { detail: 1 });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('a short Enter press opens the confirm step', () => {
    const onConfirm = vi.fn();
    render(<HoldToConfirmButton onConfirm={onConfirm}>Kill</HoldToConfirmButton>);
    const btn = screen.getByRole('button', { name: 'Kill' });
    fireEvent.keyDown(btn, { key: 'Enter' });
    act(() => vi.advanceTimersByTime(100));
    fireEvent.keyUp(btn, { key: 'Enter' });
    expect(screen.getByRole('alertdialog')).toBeVisible();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('onActivate replaces the built-in dialog (e.g. the kill-switch scope menu is the confirm step)', () => {
    const onConfirm = vi.fn();
    const onActivate = vi.fn();
    render(
      <HoldToConfirmButton onConfirm={onConfirm} onActivate={onActivate}>
        Kill
      </HoldToConfirmButton>,
    );
    act(() => screen.getByRole('button', { name: 'Kill' }).click());
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('every string is localisable (French instruction, status and dialog)', () => {
    const onConfirm = vi.fn();
    render(
      <HoldToConfirmButton
        onConfirm={onConfirm}
        locale="fr"
        labels={{
          instruction: (s) => `Maintenez ${s} s pour confirmer, ou activez une fois pour confirmer dans une fenêtre.`,
          holding: 'Maintien…',
          confirmed: 'Confirmé',
          confirmTitle: 'Confirmer ?',
          confirmBody: 'Vous pouvez aussi maintenir le bouton.',
          confirm: 'Confirmer',
          cancel: 'Annuler',
        }}
      >
        Tout arrêter
      </HoldToConfirmButton>,
    );
    const btn = screen.getByRole('button', { name: 'Tout arrêter' });
    expect(btn).toHaveAccessibleDescription('Maintenez 1,5 s pour confirmer, ou activez une fois pour confirmer dans une fenêtre.');
    act(() => btn.click());
    expect(screen.getByRole('alertdialog', { name: 'Confirmer ?' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toMatch(/Press and hold|Holding|Confirmed/);
  });
});
