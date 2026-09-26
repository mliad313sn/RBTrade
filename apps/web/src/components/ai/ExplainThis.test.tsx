// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./ai.css', () => ({}));

import { ExplainThis } from './ExplainThis';

describe('ExplainThis (novice, goal 08 places it)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('asks /ai/explain with the topic and shows the plain answer; screen text travels as data', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        status: 'ok',
        answer: 'A stop loss is a price you pick before you trade.\n\nNot investment advice.',
        flags: {},
        drafts: [],
        toolCalls: [],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<ExplainThis topic="stop loss" screenText="Stop loss (pips) 20" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Explain this to me/ }));
    });
    expect(await screen.findByTestId('explain-this-text')).toHaveProperty(
      'textContent',
      expect.stringContaining('A stop loss is a price you pick'),
    );
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/ai/explain');
    expect(JSON.parse(String(init.body))).toEqual({
      topic: 'stop loss',
      screenText: 'Stop loss (pips) 20',
      context: {},
    });
  });

  it('shows the friendly message when the copilot is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          status: 'unavailable',
          message: 'Copilot unavailable: the AI service is not configured on this server.',
        }),
      ),
    );
    render(<ExplainThis topic="spread" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Explain this to me/ }));
    });
    expect((await screen.findByTestId('explain-this-text')).textContent).toMatch(
      /^Copilot unavailable/,
    );
  });
});
