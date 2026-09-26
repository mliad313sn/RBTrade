'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

import { LOCALE_NAMES, LOCALES, type Locale } from '@/lib/i18n';
import { setLocaleCookie, useI18n } from '@/lib/i18n/react';

/** EN / FR switch for the Novice view (goal 08 §9). Two 44 px buttons, remembered in a cookie. */
export function LanguageSwitch() {
  const { locale, t } = useI18n();
  const router = useRouter();
  const [pending, start] = useTransition();
  const choose = (l: Locale) => {
    if (l === locale) return;
    setLocaleCookie(l);
    start(() => router.refresh());
  };
  return (
    <div
      role="group"
      aria-label={t('shell.lang.label')}
      className="k-seg"
      data-testid="language-switch"
    >
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          className="k-seg__opt"
          aria-pressed={l === locale}
          disabled={pending}
          onClick={() => choose(l)}
        >
          {l.toUpperCase()}
          <span className="k-sr-only"> {LOCALE_NAMES[l]}</span>
        </button>
      ))}
    </div>
  );
}
