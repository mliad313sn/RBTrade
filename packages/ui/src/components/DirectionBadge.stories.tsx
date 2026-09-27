import type { Meta, StoryObj } from '@storybook/react-vite';

import { DirectionBadge } from './DirectionBadge';

const meta = {
  title: 'Primitives/DirectionBadge',
  component: DirectionBadge,
  args: { value: '0.0018', format: 'percent' },
} satisfies Meta<typeof DirectionBadge>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Up: Story = {};
export const Down: Story = { args: { value: '-0.0135' } };
export const Flat: Story = { args: { value: '0' } };
export const Absolute: Story = { args: { value: '0.0019', format: 'number', decimals: 4 } };
