'use client';

import { COLOUR_CONVENTIONS, DEFAULT_HOTKEYS, DEFAULT_TERMINAL_SETTINGS, HOTKEY_LABELS, THEMES, type UpdatePreferences } from '@kora/domain';
import { Button, Kbd, Panel, Select, useToast } from '@kora/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { isValidHotkey } from '@/lib/terminal/hotkeys';

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
  const terminal = { ...DEFAULT_TERMINAL_SETTINGS, ...(me.preferences.terminal ?? {}) };
  const [riskPct, setRiskPct] = useState(terminal.perTradeRiskPct);
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
      <Panel title="Pro terminal">
        <div className="grid gap-4">
          <Select
            label="Number density"
            value={terminal.density}
            options={[
              { value: 'compact', label: 'Compact (default)' },
              { value: 'comfortable', label: 'Comfortable' },
            ]}
            onChange={(e) => void save({ terminal: { density: e.target.value as 'compact' | 'comfortable' } })}
            data-testid="settings-density"
          />
          <Select
            label="Times shown in"
            value={terminal.timeDisplay}
            options={[
              { value: 'utc', label: 'UTC (default)' },
              { value: 'local', label: 'My local time' },
            ]}
            onChange={(e) => void save({ terminal: { timeDisplay: e.target.value as 'utc' | 'local' } })}
            data-testid="settings-time"
          />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={terminal.soundOnFills} onChange={(e) => void save({ terminal: { soundOnFills: e.target.checked } })} data-testid="settings-sound" />
            Sound on fills (off by default)
          </label>
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void save({ terminal: { perTradeRiskPct: riskPct.trim() } });
            }}
          >
            <label className="flex flex-col gap-1 text-sm">
              <span className="k-label">Per-trade risk rule (% of equity)</span>
              <input className="k-input w-28" inputMode="decimal" value={riskPct} onChange={(e) => setRiskPct(e.target.value)} data-testid="settings-risk-pct" />
            </label>
            <Button type="submit" size="sm">
              Save
            </Button>
            <span className="text-xs text-muted">The ticket warns when the loss at your stop is above this.</span>
          </form>
        </div>
      </Panel>
      <Panel title="Hotkeys">
        <p className="m-0 mb-2 text-xs text-muted">Type a combination such as Ctrl+Shift+K, Alt+1, B or Mod+K (⌘ on macOS, Ctrl elsewhere). Single keys do nothing while you type in a field.</p>
        <dl className="grid grid-cols-[1fr_auto] gap-2 m-0 items-center">
          {Object.entries({ ...DEFAULT_HOTKEYS, ...me.preferences.hotkeys }).map(([k, v]) => (
            <div key={k} className="contents">
              <dt>{HOTKEY_LABELS[k] ?? k}</dt>
              <dd className="m-0 flex items-center gap-2">
                <Kbd>{v}</Kbd>
                <input
                  className="k-input w-36"
                  aria-label={`New shortcut for ${HOTKEY_LABELS[k] ?? k}`}
                  placeholder="New shortcut"
                  defaultValue=""
                  data-testid={`hotkey-${k}`}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    const val = (e.target as HTMLInputElement).value.trim();
                    if (!isValidHotkey(val)) return toast.push(`"${val}" is not a valid shortcut`, 'critical');
                    void save({ hotkeys: { [k]: val } });
                    (e.target as HTMLInputElement).value = '';
                  }}
                />
              </dd>
            </div>
          ))}
        </dl>
        <Button size="sm" className="mt-3" onClick={() => void save({ hotkeys: { ...DEFAULT_HOTKEYS } })} data-testid="hotkeys-reset">
          Reset shortcuts
        </Button>
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
