import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button, IconButton } from './Button';

const meta = { title: 'Primitives/Button', component: Button, args: { children: 'Button' } } satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Secondary: Story = {};
export const Primary: Story = { args: { variant: 'primary', children: 'Review order' } };
export const Buy: Story = { args: { variant: 'buy', children: 'BUY ▲ 1.08421' } };
export const Sell: Story = { args: { variant: 'sell', children: 'SELL ▼ 1.08419' } };
export const Danger: Story = { args: { variant: 'danger', children: '■ KILL SWITCH' } };
export const Disabled: Story = { args: { disabled: true, children: 'Unavailable' } };
export const Sizes: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <Button size="sm">Small</Button>
      <Button>Medium</Button>
      <Button size="lg">Large</Button>
      <IconButton label="Settings" icon="⚙" />
    </div>
  ),
};
