import type { Meta, StoryObj } from '@storybook/react-vite';

import { Chip, EnvChip } from './Chip';

const meta = {
  title: 'Primitives/Chip',
  component: Chip,
  args: { children: 'Crypto' },
} satisfies Meta<typeof Chip>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Neutral: Story = {};
export const Tones: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 8 }}>
      <EnvChip env="PAPER" />
      <Chip tone="ai">AI draft</Chip>
      <Chip tone="warn">Stale</Chip>
      <Chip>FX</Chip>
    </div>
  ),
};
