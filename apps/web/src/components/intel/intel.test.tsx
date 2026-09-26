// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { arrow, signed, trendArrow, type TrendCard } from '@/lib/intel/client';

import { DriversChart } from './DriversChart';
import { WhatsMovingCard } from './WhatsMovingCard';

describe('market intelligence components (goal 07B)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('formats numbers with signs and arrows (colour is never the only cue)', () => {
    expect(signed(0.2134, 3)).toBe('+0.213');
    expect(signed(-1.5)).toBe('−1.50');
    expect(signed(null)).toBe('—');
    expect(arrow(2)).toBe('▲');
    expect(arrow(-2)).toBe('▼');
    expect(arrow(0)).toBe('•');
    expect(trendArrow('breakout_down')).toBe('▼');
    expect(trendArrow('range')).toBe('◆');
  });

  it("What's moving shows plain headlines, the news source, and no figure unless calibrated", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          items: [
            {
              symbol: '7203.XTKS',
              name: 'Toyota Motor',
              headline: 'Toyota Motor has gone up more than usual. That is a big move for it.',
              why: 'In the news: "Toyota raises target" (SIMULATED Wire APAC).',
              whySource: { id: 'a1', source: 'SIMULATED Wire APAC', url: 'https://news.simulated.invalid/a1' },
              confidence: null,
            },
          ],
          note: 'Practice market with SIMULATED prices. This shows what moved, not what to do.',
          disclaimer: 'Not investment advice.',
        }),
      ),
    );
    render(<WhatsMovingCard />);
    expect(await screen.findByText(/Toyota Motor has gone up/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Source' }).getAttribute('data-article-id')).toBe('a1');
    expect(screen.getByTestId('whats-moving').textContent).toContain('Not investment advice.');
    expect(screen.getByTestId('whats-moving').textContent).not.toMatch(/\d+ times out of/);
  });

  it('draws driver bars from the card data with ▲▼ and signed values', () => {
    const card = {
      symbol: '7203.XTKS',
      horizon: '1d',
      drivers: [
        { feature: 'mom_z', label: 'Momentum z-score (20 bars)', value: 2.41, contribution: 0.2134 },
        { feature: 'vol_ratio', label: 'Volatility ratio (20/100)', value: 0.83, contribution: -0.0412 },
      ],
    } as unknown as TrendCard;
    render(<DriversChart card={card} />);
    const rows = screen.getAllByTestId('driver-row');
    expect(rows[0]!.textContent).toContain('▲ +0.213');
    expect(rows[1]!.textContent).toContain('▼ −0.041');
  });
});
