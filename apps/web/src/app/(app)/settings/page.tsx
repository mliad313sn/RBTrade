import { NoviceSettings, ProSettingsOnly, SettingsTitle } from '@/components/novice/NoviceSettings';
import { SettingsForm } from '@/components/SettingsForm';

export const metadata = { title: 'Settings' };

export default function SettingsPage() {
  return (
    <>
      <SettingsTitle />
      <NoviceSettings />
      <ProSettingsOnly>
        <SettingsForm />
      </ProSettingsOnly>
    </>
  );
}
