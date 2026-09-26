'use client';

import Link from 'next/link';
import {
  createContext,
  Fragment,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import { fmtDate, fmtDateTime, fmtMoney, fmtPctNumber, fmtTime } from './format';
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  makeT,
  type Locale,
  type MessageKey,
  type T,
  type Vars,
} from './index';

interface I18n {
  locale: Locale;
  t: T;
  /** True inside the Novice view (Pro screens stay in English). */
  novice: boolean;
  money: (
    amount: string | number,
    ccy: string,
    opts?: { signed?: boolean; decimals?: number },
  ) => string;
  pct: (pct: string, opts?: { signed?: boolean; decimals?: number }) => string;
  dateTime: (iso: string) => string;
  date: (iso: string) => string;
  time: (iso: string) => string;
}

/**
 * Dates and times are formatted in the browser only (after hydration): the server's ICU data and
 * time zone can differ from the viewer's, which would otherwise break hydration.
 */
function build(locale: Locale, novice: boolean, mounted: boolean): I18n {
  const when = (f: (iso: string) => string) => (iso: string) => (mounted ? f(iso) : '');
  return {
    locale,
    novice,
    t: makeT(locale),
    money: (a, c, o) => fmtMoney(a, c, locale, o),
    pct: (p, o) => fmtPctNumber(p, locale, o),
    dateTime: when((iso) => fmtDateTime(iso, locale)),
    date: when((iso) => fmtDate(iso, locale)),
    time: when((iso) => fmtTime(iso, locale)),
  };
}

const noop = () => () => undefined;

const Ctx = createContext<I18n>(build(DEFAULT_LOCALE, false, true));

export function I18nProvider({
  locale,
  novice = true,
  children,
}: {
  locale: Locale;
  novice?: boolean;
  children: ReactNode;
}) {
  const mounted = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
  const value = useMemo(() => build(locale, novice, mounted), [locale, novice, mounted]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  return useContext(Ctx);
}

/** Saves the language for a year (git-ignored preference, no personal data). */
export function setLocaleCookie(locale: Locale): void {
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`;
}

/** Link to a glossary entry: on Learn by default, or an in-page anchor (Practice). */
export function Term({ id, children, href }: { id: string; children: ReactNode; href?: string }) {
  const to = href ?? `/learn#glossary-${id}`;
  const cls = 'text-accent underline decoration-dotted underline-offset-2';
  return to.startsWith('#') ? (
    <a href={to} className={cls} data-glossary={id}>
      {children}
    </a>
  ) : (
    <Link href={to} className={cls} data-glossary={id}>
      {children}
    </Link>
  );
}

const TOKEN = /\[([^\]]+)\]\(term:([a-z0-9-]+)\)|\*\*([^*]+)\*\*/g;

/** Renders a message with inline glossary links and bold text. */
export function Rich({ text, termHref }: { text: string; termHref?: (id: string) => string }) {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index! > last) out.push(<Fragment key={i++}>{text.slice(last, m.index)}</Fragment>);
    if (m[2]) {
      out.push(
        <Term key={i++} id={m[2]} href={termHref?.(m[2])}>
          {m[1]}
        </Term>,
      );
    } else out.push(<strong key={i++}>{m[3]}</strong>);
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(<Fragment key={i++}>{text.slice(last)}</Fragment>);
  return <>{out}</>;
}

/** `t()` + `<Rich>` in one: `<Tx k="onb.s2.body" />`. */
export function Tx({
  k,
  vars,
  termHref,
}: {
  k: MessageKey;
  vars?: Vars;
  termHref?: (id: string) => string;
}) {
  const { t } = useI18n();
  return <Rich text={t(k, vars)} termHref={termHref} />;
}
