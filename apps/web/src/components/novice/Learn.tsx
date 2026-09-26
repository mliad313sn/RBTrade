'use client';

import type { DisclosureDocument } from '@kora/sdk';
import Link from 'next/link';

import { Rich, useI18n } from '@/lib/i18n/react';
import { ExplainThis } from '@/lib/novice/explain-slot';
import { GLOSSARY, lessonKeys, LESSONS, termKeys, type LessonId } from '@/lib/novice/learn';

/** Learn (goal 08 §7): 2-minute lessons, the word list every inline link points at, and the risks. */
export function Learn({ disclosure }: { disclosure: DisclosureDocument | null }) {
  const { t, locale } = useI18n();
  return (
    <div className="max-w-3xl mx-auto flex flex-col gap-6">
      <div>
        <h1 className="font-display text-3xl m-0">{t('learn.title')}</h1>
        <p className="m-0 mt-1 text-lg">{t('learn.intro')}</p>
      </div>

      <section aria-labelledby="lessons-title">
        <h2 id="lessons-title" className="text-xl mt-0">
          {t('learn.lessons')}
        </h2>
        <ul className="list-none m-0 p-0 grid gap-3 sm:grid-cols-2" data-testid="lessons">
          {LESSONS.map((id) => {
            const k = lessonKeys(id);
            return (
              <li key={id}>
                <Link
                  href={`/learn/${id}`}
                  className="k-panel block no-underline hover:border-accent min-h-11"
                  data-testid={`lesson-${id}`}
                >
                  <span className="k-panel__body block">
                    <span className="block font-semibold text-lg">{t(k.title)}</span>
                    <span className="block text-muted">{t(k.summary)}</span>
                    <span className="block text-sm text-accent mt-1">{t('learn.minutes')}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
        <Link
          href="/learn/check"
          className="k-btn mt-4 no-underline"
          data-testid="knowledge-check-link"
        >
          {t('learn.check.cta')}
        </Link>
      </section>

      <section
        id="risks"
        aria-labelledby="risks-title"
        className="k-panel scroll-mt-4"
        tabIndex={-1}
      >
        <div className="k-panel__body">
          <h2 id="risks-title" className="text-xl m-0">
            {disclosure?.title ?? t('onb.d.title')}
          </h2>
          <ul className="mt-3 mb-0 pl-5 flex flex-col gap-2" data-testid="risks-body">
            {(disclosure?.body ?? []).map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          {disclosure?.placeholder ? (
            <p className="text-sm text-muted mb-0">{t('shell.banner.placeholder')}</p>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="glossary-title" data-testid="glossary">
        <h2 id="glossary-title" className="text-xl mt-0">
          {t('learn.glossary')}
        </h2>
        <dl className="m-0 flex flex-col gap-3">
          {GLOSSARY.map((id) => {
            const k = termKeys(id);
            return (
              <div
                key={id}
                id={`glossary-${id}`}
                tabIndex={-1}
                className="k-panel k-panel__body scroll-mt-4"
              >
                <dt className="font-semibold">{t(k.name)}</dt>
                <dd className="m-0 text-muted">
                  {t(k.meaning)}{' '}
                  <ExplainThis topic="glossary_term" locale={locale} context={{ term: id }} />
                </dd>
              </div>
            );
          })}
        </dl>
      </section>
    </div>
  );
}

export function Lesson({ id }: { id: LessonId }) {
  const { t, locale } = useI18n();
  const k = lessonKeys(id);
  return (
    <article className="max-w-2xl mx-auto k-panel" data-testid="lesson">
      <div className="k-panel__body flex flex-col gap-3">
        <Link href="/learn" className="text-accent inline-flex items-center min-h-11">
          ← {t('learn.all')}
        </Link>
        <p className="m-0 text-sm text-muted">{t('learn.minutes')}</p>
        <h1 className="font-display text-3xl m-0">{t(k.title)}</h1>
        {k.paragraphs.map((p) => (
          <p key={p} className="m-0 text-lg leading-relaxed">
            <Rich text={t(p)} />
          </p>
        ))}
        <ExplainThis topic="lesson" locale={locale} context={{ lesson: id }} />
      </div>
    </article>
  );
}
