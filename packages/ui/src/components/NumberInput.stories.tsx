import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { NumberInput, type NumberInputProps } from './NumberInput';

function Controlled(
  props: Omit<NumberInputProps, 'value' | 'onValueChange'> & { initial: string },
) {
  const { initial, ...rest } = props;
  const [v, setV] = useState(initial);
  return <NumberInput {...rest} value={v} onValueChange={setV} />;
}

const meta = {
  title: 'Primitives/NumberInput',
  component: Controlled,
  args: { label: 'Limit price', precision: 5, step: '0.00001', initial: '1.08421' },
} satisfies Meta<typeof Controlled>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Price: Story = {};
export const Quantity: Story = {
  args: { label: 'Quantity (units)', precision: 0, step: '1000', initial: '100000', min: '0' },
};
export const WithError: Story = {
  args: { label: 'Stop loss (pips)', precision: 1, initial: '0', error: 'Stop must be above 0' },
};
