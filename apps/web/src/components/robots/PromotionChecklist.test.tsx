// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { ChecklistView } from '@/lib/robots/types';

import { PromotionChecklist } from './MonitorParts';

afterEach(cleanup);

const view = (complete: boolean): ChecklistView =>
  ({
    robotId: 'r1',
    items: [
      { id: 'oos', label: 'Out-of-sample Sharpe above the bar', pass: true },
      { id: 'paper', label: '30 days of paper trading', pass: complete },
    ],
    complete,
    liveTradingEnabled: false,
    blockedReason: complete ? null : 'Complete every item first.',
    limitsHash: 'h',
    history: [],
  }) as unknown as ChecklistView;

describe('robot promotion checklist semantics (IRTC R5-24)', () => {
  it('is a status list, not read-only checkboxes, and Promote is disabled until complete', () => {
    render(<PromotionChecklist robotId="r1" view={view(false)} onChange={() => undefined} />);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.getByTestId('check-oos').getAttribute('data-pass')).toBe('true');
    expect(screen.getByTestId('check-paper').textContent).toContain('✗ missing');
    expect((screen.getByTestId('promote-open') as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables Promote once every item has evidence', () => {
    render(<PromotionChecklist robotId="r1" view={view(true)} onChange={() => undefined} />);
    expect((screen.getByTestId('promote-open') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId('promote-open').textContent).toBe('Promote (2FA)');
  });
});
