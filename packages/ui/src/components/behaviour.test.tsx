import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DirectionBadge } from './DirectionBadge';
import { HoldToConfirmButton } from './HoldToConfirmButton';
import { isPartialDecimal, normaliseDecimal, NumberInput } from './NumberInput';
import { SegmentedControl } from './SegmentedControl';
import { Table } from './Table';
import { ToastProvider, useToast } from './Toast';
import { Dialog } from './Dialog';
import { Money, Price } from './Money';
import { EnvChip } from './Chip';
import { Tabs } from './Tabs';
import { IconButton } from './Button';

describe('HoldToConfirmButton', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('confirms only after the full hold (pointer)', () => {
    const onConfirm = vi.fn();
    render(<HoldToConfirmButton onConfirm={onConfirm}>Kill</HoldToConfirmButton>);
    const btn = screen.getByRole('button', { name: 'Kill' });
    fireEvent.pointerDown(btn, { button: 0, pointerId: 1 });
    act(() => vi.advanceTimersByTime(1499));
    expect(onConfirm).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('cancels when released early (pointer up / leave)', () => {
    const onConfirm = vi.fn();
    render(<HoldToConfirmButton onConfirm={onConfirm}>Kill</HoldToConfirmButton>);
    const btn = screen.getByRole('button');
    fireEvent.pointerDown(btn, { button: 0 });
    act(() => vi.advanceTimersByTime(1000));
    fireEvent.pointerUp(btn);
    act(() => vi.advanceTimersByTime(2000));
    fireEvent.pointerDown(btn, { button: 0 });
    act(() => vi.advanceTimersByTime(700));
    fireEvent.pointerLeave(btn);
    act(() => vi.advanceTimersByTime(2000));
    fireEvent.pointerDown(btn, { button: 2 }); // right click never starts
    act(() => vi.advanceTimersByTime(2000));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('works with keyboard Space-hold and Enter-hold; key repeat does not restart', () => {
    const onConfirm = vi.fn();
    render(<HoldToConfirmButton onConfirm={onConfirm} holdMs={1500}>Kill</HoldToConfirmButton>);
    const btn = screen.getByRole('button');
    fireEvent.keyDown(btn, { key: ' ' });
    act(() => vi.advanceTimersByTime(800));
    fireEvent.keyDown(btn, { key: ' ', repeat: true });
    act(() => vi.advanceTimersByTime(700));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.keyUp(btn, { key: ' ' });
    fireEvent.keyDown(btn, { key: 'Enter' });
    act(() => vi.advanceTimersByTime(500));
    fireEvent.keyUp(btn, { key: 'Enter' });
    act(() => vi.advanceTimersByTime(2000));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(btn, { key: ' ' });
    fireEvent.keyDown(btn, { key: 'Escape' });
    act(() => vi.advanceTimersByTime(2000));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('announces the hold instruction and ignores input when disabled', () => {
    const onConfirm = vi.fn();
    render(<HoldToConfirmButton onConfirm={onConfirm} disabled description="Opens the scope menu.">Kill</HoldToConfirmButton>);
    const btn = screen.getByRole('button');
    expect(btn).toHaveAccessibleDescription('Press and hold for 1.5 seconds to confirm, or activate once to confirm in a dialog. Opens the scope menu.');
    fireEvent.keyDown(btn, { key: ' ' });
    act(() => vi.advanceTimersByTime(2000));
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('NumberInput (decimal-safe)', () => {
  it('accepts only partial decimals within precision', () => {
    expect(isPartialDecimal('1.084', 5, false)).toBe(true);
    expect(isPartialDecimal('1.', 5, false)).toBe(true);
    expect(isPartialDecimal('1.123456', 5, false)).toBe(false);
    expect(isPartialDecimal('-1', 2, false)).toBe(false);
    expect(isPartialDecimal('-', 2, true)).toBe(true);
    expect(isPartialDecimal('1e5', 2, false)).toBe(false);
    expect(isPartialDecimal('1.5', 0, false)).toBe(false);
  });
  it('normalises to precision and clamps with Decimal maths', () => {
    expect(normaliseDecimal('1.1', 5)).toBe('1.10000');
    expect(normaliseDecimal('.5', 2)).toBe('0.50');
    expect(normaliseDecimal('3.', 0)).toBe('3');
    expect(normaliseDecimal('-.5', 1)).toBe('-0.5');
    expect(normaliseDecimal('', 2)).toBe('');
    expect(normaliseDecimal('-', 2)).toBe('');
    expect(normaliseDecimal('0.1', 2, '0.5', '9')).toBe('0.50');
    expect(normaliseDecimal('12', 2, '0', '9')).toBe('9.00');
    expect(normaliseDecimal('0.30000000000000004', 2)).toBe('0.30');
  });

  function Harness({ initial = '1.08421', min }: { initial?: string; min?: string }) {
    const [v, setV] = useState(initial);
    return (
      <>
        <NumberInput label="Limit price" value={v} onValueChange={setV} precision={5} step="0.00001" min={min} />
        <output data-testid="out">{v}</output>
      </>
    );
  }

  it('filters typing, steps with arrows and normalises on blur', () => {
    render(<Harness />);
    const input = screen.getByLabelText('Limit price');
    fireEvent.change(input, { target: { value: '1.0842x' } });
    expect(screen.getByTestId('out').textContent).toBe('1.08421');
    fireEvent.change(input, { target: { value: '1,1' } });
    expect(screen.getByTestId('out').textContent).toBe('1.1');
    fireEvent.blur(input);
    expect(screen.getByTestId('out').textContent).toBe('1.10000');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getByTestId('out').textContent).toBe('1.10001');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByTestId('out').textContent).toBe('1.09999');
  });

  it('does not step below zero when negatives are not allowed', () => {
    render(<Harness initial="0.00000" />);
    const input = screen.getByLabelText('Limit price');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByTestId('out').textContent).toBe('0.00000');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getByTestId('out').textContent).toBe('0.00001');
  });
});

describe('SegmentedControl', () => {
  it('uses radio semantics and arrow keys', () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl label="View mode" value="pro" onChange={onChange} options={[{ value: 'pro', label: 'Pro' }, { value: 'novice', label: 'Novice' }]} />,
    );
    expect(screen.getByRole('radio', { name: 'Pro' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Pro' }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('novice');
    fireEvent.click(screen.getByRole('radio', { name: 'Novice' }));
    expect(onChange).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('radio', { name: 'Pro' }));
    expect(onChange).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Pro' }), { key: 'x' });
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Pro' }), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('novice');
  });
});

describe('display primitives', () => {
  it('DirectionBadge shows arrow, sign and a spoken label (colour is never the only cue)', () => {
    const { container } = render(<DirectionBadge value="-0.0135" format="percent" />);
    expect(container.textContent).toContain('▼');
    expect(container.textContent).toContain('−1.35%');
    expect(screen.getByText('down 1.35%')).toBeInTheDocument();
    render(<DirectionBadge value="0.0019" decimals={4} suffix="USD" />);
    expect(screen.getByText('up 0.0019 USD')).toBeInTheDocument();
  });
  it('Money and Price format from decimal strings', () => {
    render(<><Money amount="-744" currency="USD" signed colored /><Price value="1.0842" precision={5} /></>);
    expect(screen.getByText('−744.00 USD')).toHaveAttribute('data-direction', 'down');
    expect(screen.getByText('1.08420')).toBeInTheDocument();
  });
  it('EnvChip always labels PAPER as simulated', () => {
    render(<EnvChip env="PAPER" />);
    expect(screen.getByTestId('env-chip')).toHaveAccessibleName('Trading environment: paper (simulated money)');
  });
  it('IconButton requires an accessible name', () => {
    render(<IconButton label="Settings" icon="⚙" />);
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
  });
});

describe('Table', () => {
  it('virtualises: renders a window of rows but reports the total', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: String(i) }));
    render(<Table label="Rows" rows={rows} rowKey={(r) => r.id} columns={[{ key: 'id', header: 'Id', cell: (r) => r.id }]} height={200} rowHeight={20} />);
    expect(screen.getByRole('table')).toHaveAttribute('aria-rowcount', '1001');
    const rendered = screen.getAllByRole('row').length;
    expect(rendered).toBeGreaterThan(1);
    expect(rendered).toBeLessThan(60);
  });
  it('shows an empty state', () => {
    render(<Table label="Rows" rows={[]} rowKey={() => 'x'} columns={[{ key: 'id', header: 'Id', cell: () => null }]} empty="No orders" />);
    expect(screen.getByText('No orders')).toBeInTheDocument();
  });
});

describe('Toast, Dialog, Tabs', () => {
  it('pushes and expires toasts; critical ones use role=alert', () => {
    vi.useFakeTimers();
    function Push() {
      const t = useToast();
      return (
        <>
          <button onClick={() => t.push('Saved', 'success', 1000)}>save</button>
          <button onClick={() => t.push('Engaged', 'critical', 1000)}>crit</button>
        </>
      );
    }
    render(<ToastProvider><Push /></ToastProvider>);
    fireEvent.click(screen.getByText('save'));
    fireEvent.click(screen.getByText('crit'));
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
    expect(screen.getByRole('alert')).toHaveTextContent('Engaged');
    act(() => vi.advanceTimersByTime(1100));
    expect(screen.queryByText('Saved')).toBeNull();
    vi.useRealTimers();
  });
  it('useToast outside the provider throws', () => {
    function Bad() {
      useToast();
      return null;
    }
    expect(() => render(<Bad />)).toThrow(/ToastProvider/);
  });
  it('Dialog renders title, description and alertdialog role', () => {
    render(<Dialog open onOpenChange={() => undefined} title="Kill switch" description="Choose a scope" alert />);
    expect(screen.getByRole('alertdialog', { name: 'Kill switch' })).toHaveAccessibleDescription('Choose a scope');
  });
  it('Tabs switch content', () => {
    render(<Tabs label="t" items={[{ value: 'a', label: 'A', content: 'Alpha' }, { value: 'b', label: 'B', content: 'Beta' }]} />);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'B' }));
    expect(screen.getByRole('tab', { name: 'B' })).toHaveAttribute('aria-selected', 'true');
  });
});
