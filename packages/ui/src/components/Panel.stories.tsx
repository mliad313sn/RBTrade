import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button } from './Button';
import { Panel } from './Panel';

const meta = {
  title: 'Primitives/Panel',
  component: Panel,
  args: { title: 'Watchlist · Majors', children: <p>Panel body</p> },
} satisfies Meta<typeof Panel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const WithActions: Story = { args: { actions: <Button size="sm">Add</Button> } };
