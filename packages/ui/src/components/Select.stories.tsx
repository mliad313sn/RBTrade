import type { Meta, StoryObj } from '@storybook/react-vite';

import { Select } from './Select';

const meta = {
  title: 'Primitives/Select',
  component: Select,
  args: {
    label: 'Time in force',
    options: [
      { value: 'gtc', label: 'GTC' },
      { value: 'day', label: 'Day' },
      { value: 'ioc', label: 'IOC' },
    ],
  },
} satisfies Meta<typeof Select>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const WithHint: Story = { args: { hint: 'Good till cancelled by default' } };
