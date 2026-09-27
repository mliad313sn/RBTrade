import { NoviceSettings, ProSettingsOnly, SettingsTitle } from '@/components/novice/NoviceSettings';
import { SettingsForm } from '@/components/SettingsForm';
import { localisedTitle } from '@/lib/i18n/metadata';

/** Localised page title (IRTC R5-12). */
export function generateMetadata() {
  return localisedTitle('meta.settings', { sharedWithPro: true });
}

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
