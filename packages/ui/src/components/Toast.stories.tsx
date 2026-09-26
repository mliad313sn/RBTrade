import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button } from './Button';
import { ToastProvider, ToastViewport, useToast } from './Toast';

function Trigger() {
  const t = useToast();
  return <Button onClick={() => t.push('Kill switch recorded in the audit log', 'success')}>Show toast</Button>;
}

function Demo() {
  return (
    <ToastProvider>
      <Trigger />
    </ToastProvider>
  );
}

const meta = { title: 'Primitives/Toast', component: Demo } satisfies Meta<typeof Demo>;
export default meta;
export const Interactive: StoryObj<typeof meta> = {};
export const Static: StoryObj<typeof meta> = {
  render: () => (
    <ToastViewport
      items={[
        { id: 1, tone: 'info', message: 'Feed reconnected' },
        { id: 2, tone: 'success', message: 'Preferences saved' },
        { id: 3, tone: 'critical', message: 'Kill switch engaged' },
      ]}
    />
  ),
};
