// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n/react';
import { explainScreenText, explainTopicWords, NoviceExplainThis } from './explain-copilot';
import { ExplainModeProvider, ExplainThis, registerExplainThis } from './explain-slot';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  registerExplainThis(null);
});

describe('goal 07 novice copilot in the goal 08 "Explain this to me" slot', () => {
  it('maps the typed topic and on-screen values to plain topic words and untrusted screen text', () => {
    expect(explainTopicWords('most_you_could_lose', {})).toBe(
      'the most you could lose on this trade',
    );
    expect(explainTopicWords('glossary_term', { term: 'safety-net' })).toBe(
      'the word "safety net"',
    );
    expect(explainTopicWords('lesson', { lesson: 'losses' })).toBe('the lesson "losses"');
    for (const t of ['spread_and_fees', 'robot_risk_level', 'practice_year'] as const)
      expect(explainTopicWords(t, {}).length).toBeLessThanOrEqual(60);
    expect(explainScreenText({ symbol: 'EURUSD', loss: '16.50', empty: '' })).toBe(
      'symbol: EURUSD\nloss: 16.50',
    );
    expect(explainScreenText({})).toBeUndefined();
  });

  it('asks POST /ai/explain with a novice panel, localised labels, and tells French viewers the answer is in English', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        status: 'ok',
        answer: 'A stop closes your trade at a set price.\nNot investment advice.',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    act(() => registerExplainThis(NoviceExplainThis));
    render(
      <I18nProvider locale="fr">
        <ExplainModeProvider mode="on">
          <ExplainThis
            topic="most_you_could_lose"
            locale="fr"
            context={{ symbol: 'EURUSD', loss: '16.50' }}
          />
        </ExplainModeProvider>
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Expliquez-moi ceci' }));
    expect(await screen.findByText('A stop closes your trade at a set price.')).toBeTruthy();
    expect(screen.getByText('La réponse est en anglais pour le moment.')).toBeTruthy();
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const [url, init] = calls[0]!;
    expect(url).toMatch(/\/ai\/explain$/);
    expect(JSON.parse(String(init.body))).toEqual({
      topic: 'the most you could lose on this trade',
      screenText: 'symbol: EURUSD\nloss: 16.50',
      context: { panel: 'novice_most_you_could_lose' },
    });
  });
});
