import type { Meta, StoryObj } from '@storybook/react-vite';

import { Banner } from './Banner';

const meta = { title: 'Primitives/Banner', component: Banner } satisfies Meta<typeof Banner>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Info: Story = { args: { tone: 'info', title: 'Simulated feed.', children: 'Prices are not market data.' } };
export const Warn: Story = {
  args: {
    tone: 'warn',
    title: 'Trading can lose you money.',
    children: "[XX]% of retail accounts lose money trading with this provider. You're using practice money.",
  },
};
export const Critical: Story = { args: { tone: 'critical', title: 'Kill switch engaged.', children: 'Robots halted.' } };
