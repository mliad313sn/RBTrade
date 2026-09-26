'use client';

import { COLOUR_CONVENTIONS, THEMES, type UpdatePreferences } from '@kora/domain';
import { Kbd, Panel, Select, useToast } from '@kora/ui';
import { useRouter } from 'next/navigation';

import { api } from '@/lib/api-browser';

import { useShell } from './shell/ShellContext';

const THEME_LABEL: Record<(typeof THEMES)[number], string> = {
  system: 'Follow view (Pro dark, Simple light)',
  'pro-dark': 'Pro dark',
  'novice-light': 'Light',
};
const COLOUR_LABEL: Record<(typeof COLOUR_CONVENTIONS)[number], string> = {
  blue_orange: 'Blue up / orange down (colour-blind safe, default)',
  green_red: 'Green up / red down',
  red_up_asia: 'Red up / green down (Asia)',
};

export function SettingsForm() {
  const { me, setMe } = useShell();
  const toast = useToast();
  const router = useRouter();
  const save = async (patch: UpdatePreferences) => {
    try {
      const r = await api.updatePreferences(patch);
      setMe({ ...me, preferences: r.preferences, capabilities: r.capabilities });
      toast.push('Saved', 'success', 3000);
      router.refresh();
    } catch {
      toast.push('Could not save your settings', 'critical');
    }
  };
  return (
    <div className="grid gap-4 max-w-2xl">
      <Panel title="Display">
        <div className="grid gap-4">
          <Select
            label="Theme"
            value={me.preferences.theme}
            options={THEMES.map((t) => ({ value: t, label: THEME_LABEL[t] }))}
            onChange={(e) => void save({ theme: e.target.value as UpdatePreferences['theme'] })}
          />
          <Select
            label="Up / down colours"
            hint="Direction is always shown with ▲▼ and +/− as well as colour."
            value={me.preferences.colourConvention}
            options={COLOUR_CONVENTIONS.map((c) => ({ value: c, label: COLOUR_LABEL[c] }))}
            onChange={(e) => void save({ colourConvention: e.target.value as UpdatePreferences['colourConvention'] })}
          />
        </div>
      </Panel>
      <Panel title="Hotkeys">
        <dl className="grid grid-cols-2 gap-2 m-0">
          {Object.entries(me.preferences.hotkeys).map(([k, v]) => (
            <div key={k} className="contents">
              <dt>{k === 'killSwitch' ? 'Kill switch (hold 1.5 s)' : k === 'commandPalette' ? 'Command palette' : k}</dt>
              <dd className="m-0">
                <Kbd>{v}</Kbd>
              </dd>
            </div>
          ))}
        </dl>
      </Panel>
      <Panel title="Security">
        <p className="m-0">
          Two-factor authentication: <strong>{me.mfa ? 'on for this session' : 'not used for this session'}</strong>. Roles:{' '}
          {me.roles.join(', ')}.
        </p>
      </Panel>
    </div>
  );
}
