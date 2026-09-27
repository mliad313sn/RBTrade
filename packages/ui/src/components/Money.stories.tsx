import type { Meta, StoryObj } from '@storybook/react-vite';

import { Money, Price } from './Money';

const meta = {
  title: 'Primitives/Money',
  component: Money,
  args: { amount: '250000', currency: 'USD' },
} satisfies Meta<typeof Money>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Pro: Story = {};
export const NoviceSymbol: Story = { args: { amount: '10482.30', display: 'symbol' } };
export const SignedPnl: Story = { args: { amount: '-744', signed: true, colored: true } };
export const Prices: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 4 }}>
      <Price value="1.0842" precision={5} />
      <Price value="148.215" precision={3} />
      <Price value="64812.5" precision={1} />
    </div>
  ),
};
