import type { Meta, StoryObj } from '@storybook/react-vite';

import { Input } from './Input';

const meta = { title: 'Primitives/Input', component: Input, args: { label: 'Email', placeholder: 'you@example.com' } } satisfies Meta<typeof Input>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const WithHint: Story = { args: { label: 'Display name', hint: 'Shown to you only' } };
export const WithError: Story = { args: { label: 'Password', type: 'password', error: 'Use at least 12 characters' } };
