import { SettingsForm } from '@/components/SettingsForm';

export const metadata = { title: 'Settings' };

export default function SettingsPage() {
  return (
    <>
      <h1 className="font-display text-2xl mt-0">Settings</h1>
      <SettingsForm />
    </>
  );
}
