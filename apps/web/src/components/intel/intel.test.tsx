// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '@/lib/i18n/react';
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

  it("What's moving is worded in the viewer's language from the structured fields (goal 08 i18n)", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          items: [
            {
              symbol: 'EURUSD',
              name: 'Euro / US Dollar',
              headline: 'Euro / US Dollar has gone down more than usual. That is a big move for it.',
              why: 'In the news: "ECB holds rates" (SIMULATED Wire EMEA).',
              whySource: { id: 'a2', source: 'SIMULATED Wire EMEA', url: 'https://news.simulated.invalid/a2' },
              confidence: 'In the past, forecasts like this came true about 57 times out of 100 (120 cases).',
              move: 'down',
              news: { title: 'ECB holds rates', source: 'SIMULATED Wire EMEA' },
              odds: { per100: 57, n: 120 },
            },
          ],
          note: 'Practice market with SIMULATED prices. This shows what moved, not what to do.',
          disclaimer: 'Not investment advice.',
        }),
      ),
    );
    render(
      <I18nProvider locale="fr">
        <WhatsMovingCard names={{ EURUSD: 'Euro / dollar US' }} />
      </I18nProvider>,
    );
    expect(await screen.findByText(/Euro \/ dollar US a baissé plus que d’habitude/)).toBeTruthy();
    const card = screen.getByTestId('whats-moving');
    expect(card.textContent).toContain('Ce qui bouge et pourquoi');
    expect(card.textContent).toContain('« ECB holds rates » (SIMULATED Wire EMEA)');
    expect(card.textContent).toContain('57 fois sur 100 (120 cas)');
    expect(card.textContent).toContain('Ceci n’est pas un conseil en investissement.');
    expect(screen.getByRole('link', { name: 'Source' }).getAttribute('data-article-id')).toBe('a2');
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
