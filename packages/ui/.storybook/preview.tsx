import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-sans-condensed/400.css';
import '@fontsource/ibm-plex-sans-condensed/600.css';
import '@fontsource/figtree/400.css';
import '@fontsource/figtree/600.css';
import '@fontsource-variable/fraunces';
import '../src/styles/tokens.generated.css';
import '../src/styles/primitives.css';

import type { Decorator, Parameters } from '@storybook/react-vite';

export const globalTypes = {
  theme: {
    description: 'KORA theme',
    toolbar: {
      title: 'Theme',
      items: [
        { value: 'pro-dark', title: 'Pro · dark' },
        { value: 'novice-light', title: 'Novice · light' },
      ],
      dynamicTitle: true,
    },
  },
  colors: {
    description: 'Colour convention',
    toolbar: {
      title: 'Colours',
      items: ['blue_orange', 'green_red', 'red_up_asia'],
      dynamicTitle: true,
    },
  },
};

export const initialGlobals = { theme: 'pro-dark', colors: 'blue_orange' };

export const decorators: Decorator[] = [
  (Story, ctx) => (
    <div
      data-theme={(ctx.globals.theme as string) ?? 'pro-dark'}
      data-colors={(ctx.globals.colors as string) ?? 'blue_orange'}
      className="k-root"
      style={{ padding: 24, minHeight: '100%' }}
    >
      <main>
        <Story />
      </main>
    </div>
  ),
];

export const parameters: Parameters = {
  layout: 'fullscreen',
  a11y: { test: 'error' },
  backgrounds: { disable: true },
};
