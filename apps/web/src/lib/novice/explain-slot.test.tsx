// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { I18nProvider } from '../i18n/react';
import {
  ExplainModeProvider,
  ExplainThis,
  parseExplainMode,
  registerExplainThis,
  type ExplainSlotProps,
} from './explain-slot';

afterEach(cleanup);

describe('"Explain this to me" slot (goal 07 fills it)', () => {
  it('renders nothing when off or unregistered; renders the registered component with plain context when on', () => {
    expect(parseExplainMode(undefined)).toBe('off');
    expect(parseExplainMode('on')).toBe('on');
    const seen: ExplainSlotProps[] = [];
    function Fake(p: ExplainSlotProps) {
      seen.push(p);
      return <button type="button">Explain</button>;
    }
    const ui = (mode: 'on' | 'off') => (
      <I18nProvider locale="fr">
        <ExplainModeProvider mode={mode}>
          <ExplainThis topic="most_you_could_lose" locale="fr" context={{ loss: '16.50' }} />
        </ExplainModeProvider>
      </I18nProvider>
    );
    const { rerender } = render(ui('on'));
    expect(screen.queryByRole('button', { name: 'Explain' })).toBeNull();
    act(() => registerExplainThis(Fake));
    rerender(ui('off'));
    expect(screen.queryByRole('button', { name: 'Explain' })).toBeNull();
    rerender(ui('on'));
    expect(screen.getByRole('button', { name: 'Explain' })).toBeTruthy();
    expect(seen.at(-1)).toEqual({
      topic: 'most_you_could_lose',
      locale: 'fr',
      context: { loss: '16.50' },
      mode: 'novice',
    });
    act(() => registerExplainThis(null));
  });
});
