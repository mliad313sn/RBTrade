'use client';

import { COLOUR_CONVENTIONS, type ColourConvention } from '@kora/domain';
import { KoraApiError } from '@kora/sdk';
import { Button, Input, Panel, Select, useToast } from '@kora/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { useShell } from '@/components/shell/ShellContext';
import { api } from '@/lib/api-browser';
import { useI18n } from '@/lib/i18n/react';

import { LanguageSwitch } from './LanguageSwitch';

/**
 * Novice settings (goal 08): language, and optional two-step sign-in (B-017). MFA is mandatory
 * only for Pro roles; a novice may turn it on here, after which every login asks for a code.
 */
export function NoviceSettings() {
  const { me, setMe } = useShell();
  const { t, novice } = useI18n();
  const toast = useToast();
  const router = useRouter();
  const [enrol, setEnrol] = useState<{ mfaToken: string; secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!novice) return null;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.mfaOptIn();
      const QRCode = (await import('qrcode')).default;
      setEnrol({
        mfaToken: r.mfaToken,
        secret: r.secret,
        qr: await QRCode.toDataURL(r.otpauthUrl, { margin: 1, width: 180 }),
      });
    } catch {
      setError(t('common.error'));
    } finally {
      setBusy(false);
    }
  };
  const verify = async () => {
    if (!enrol) return;
    setBusy(true);
    setError(null);
    try {
      await api.mfaVerify(enrol.mfaToken, code.trim());
      toast.push(t('settings.twoStep.on'), 'success', 6000);
      setEnrol(null);
      router.refresh();
    } catch (e) {
      setError(e instanceof KoraApiError ? t('settings.twoStep.bad') : t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-4 max-w-2xl mb-4" data-testid="novice-settings">
      <Panel title={t('settings.lang.title')}>
        <LanguageSwitch />
      </Panel>
      <Panel title={t('settings.colours.title')}>
        <Select
          label={t('settings.colours.title')}
          hint={t('settings.colours.hint')}
          value={me.preferences.colourConvention}
          options={COLOUR_CONVENTIONS.map((c) => ({ value: c, label: t(`settings.colours.${c}`) }))}
          onChange={async (e) => {
            try {
              const r = await api.updatePreferences({
                colourConvention: e.target.value as ColourConvention,
              });
              setMe({ ...me, preferences: r.preferences, capabilities: r.capabilities });
              toast.push(t('settings.saved'), 'success', 3000);
            } catch {
              toast.push(t('common.error'), 'critical');
            }
          }}
        />
      </Panel>
      <Panel title={t('settings.twoStep.title')} data-testid="two-step">
        <p className="m-0">{t('settings.twoStep.body')}</p>
        {me.mfa ? (
          <p className="m-0 mt-2 font-semibold">{t('settings.twoStep.on')}</p>
        ) : enrol ? (
          <div className="flex flex-col gap-3 mt-3">
            <p className="m-0">{t('settings.twoStep.scan')}</p>
            {/* eslint-disable-next-line @next/next/no-img-element -- data URL, generated in the browser */}
            <img
              src={enrol.qr}
              width={180}
              height={180}
              alt={t('settings.twoStep.qr')}
              className="self-start"
            />
            <p className="m-0 text-sm break-all">
              {t('settings.twoStep.secret', { secret: enrol.secret })}
            </p>
            <Input
              label={t('settings.twoStep.code')}
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              data-testid="two-step-code"
            />
            <Button
              variant="primary"
              disabled={busy || code.trim().length !== 6}
              onClick={() => void verify()}
              data-testid="two-step-verify"
            >
              {t('settings.twoStep.verify')}
            </Button>
          </div>
        ) : (
          <Button
            className="mt-3"
            disabled={busy}
            onClick={() => void start()}
            data-testid="two-step-start"
          >
            {t('settings.twoStep.start')}
          </Button>
        )}
        {error ? (
          <p className="k-error mt-2 mb-0" role="alert">
            {error}
          </p>
        ) : null}
      </Panel>
    </div>
  );
}

/** The Pro settings (terminal, hotkeys) only in the Pro view; the Novice view has its own panel. */
export function ProSettingsOnly({ children }: { children: React.ReactNode }) {
  const { novice } = useI18n();
  return novice ? null : <>{children}</>;
}

/** Page title: localised in the Novice view, English in Pro. */
export function SettingsTitle() {
  const { t, novice } = useI18n();
  return <h1 className="font-display text-2xl mt-0">{novice ? t('user.settings') : 'Settings'}</h1>;
}
