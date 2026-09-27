/**
 * Renders every Storybook story of every primitive (portable stories) in both themes and runs axe.
 * jsdom cannot compute colours, so `color-contrast` is covered by scripts/contrast.ts (token check)
 * and by the Playwright axe scan of the real app in Chromium.
 */
import { composeStories } from '@storybook/react-vite';
import type React from 'react';
import { cleanup, render } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';

type StoryModule = Parameters<typeof composeStories>[0];
const modules = import.meta.glob<StoryModule>('./components/*.stories.tsx', { eager: true });

afterEach(cleanup);

const COMPONENTS = [
  'Button',
  'Input',
  'NumberInput',
  'Select',
  'Tabs',
  'Panel',
  'Table',
  'Chip',
  'Dialog',
  'HoldToConfirmButton',
  'Toast',
  'Banner',
  'Kbd',
  'DirectionBadge',
  'Money',
  'SegmentedControl',
];

describe('storybook coverage', () => {
  it('every primitive has at least one story', () => {
    const files = Object.keys(modules).map((p) =>
      p.replace('./components/', '').replace('.stories.tsx', ''),
    );
    for (const c of COMPONENTS) expect(files).toContain(c);
  });
});

for (const [path, mod] of Object.entries(modules)) {
  const stories = composeStories(mod) as Record<string, React.ComponentType>;
  describe(mod.default.title ?? path, () => {
    for (const [name, Story] of Object.entries(stories)) {
      for (const theme of ['pro-dark', 'novice-light'] as const) {
        it(`${name} [${theme}] has no axe violations`, async () => {
          const { baseElement } = render(<Story />, {
            container: document.body.appendChild(document.createElement('div')),
          });
          document.documentElement.setAttribute('data-theme', theme);
          const res = await axe.run(baseElement, {
            rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
          });
          const summary = res.violations.map(
            (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
          );
          expect(summary).toEqual([]);
        });
      }
    }
  });
}
