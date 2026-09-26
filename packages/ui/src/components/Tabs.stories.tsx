import type { Meta, StoryObj } from '@storybook/react-vite';

import { Tabs } from './Tabs';

const meta = {
  title: 'Primitives/Tabs',
  component: Tabs,
  args: {
    label: 'Blotter',
    items: [
      { value: 'positions', label: 'Positions', content: <p>Open positions</p> },
      { value: 'orders', label: 'Orders (2)', content: <p>Working orders</p> },
      { value: 'fills', label: 'Fills', content: <p>Fills</p> },
    ],
  },
} satisfies Meta<typeof Tabs>;
export default meta;
export const Default: StoryObj<typeof meta> = {};
