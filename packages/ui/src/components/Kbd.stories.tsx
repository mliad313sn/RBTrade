import type { Meta, StoryObj } from '@storybook/react-vite';

import { Kbd } from './Kbd';

const meta = { title: 'Primitives/Kbd', component: Kbd, args: { children: '⌘K' } } satisfies Meta<
  typeof Kbd
>;
export default meta;
export const Default: StoryObj<typeof meta> = {};
export const Combo: StoryObj<typeof meta> = {
  render: () => (
    <p>
      Kill switch: <Kbd>Ctrl</Kbd> + <Kbd>Shift</Kbd> + <Kbd>K</Kbd> (hold)
    </p>
  ),
};
