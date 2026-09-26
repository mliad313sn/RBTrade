'use client';

import { ExplainThis as CopilotExplain } from '@/components/ai/ExplainThis';
import { useI18n } from '@/lib/i18n/react';

import type { ExplainSlotProps, ExplainTopic } from './explain-slot';

/**
 * Fills goal 08's typed "Explain this to me" slot with goal 07's novice copilot (`ExplainThis`,
 * `POST /ai/explain`): plain words (grade ≤ 8, checked on the server), no trade suggestions, no
 * drafts, nothing that places orders or changes limits. Only mounted inside the Novice shell, and
 * only when `KORA_EXPLAIN_THIS=on`. The screen values go as untrusted screen text, never as
 * instructions. Labels come from the Novice copy (EN/FR); the answer itself is in English for now
 * (B-706), which French viewers are told.
 */
const TOPIC_WORDS: Record<ExplainTopic, string> = {
  most_you_could_lose: 'the most you could lose on this trade',
  safety_net: 'the safety net (stop loss)',
  spread_and_fees: 'the spread and fees on this trade',
  borrowing: 'borrowing (leverage)',
  cooling_off: 'the break after losses (cooling-off)',
  loss_limits: 'daily and monthly loss limits',
  robot_risk_level: 'the risk level of a ready-made robot',
  past_results: 'past results of a ready-made robot',
  practice_year: 'the practice year result',
  glossary_term: 'a word from the word list',
  lesson: 'this lesson',
};

/** Plain topic words for the server (≤ 60 characters), naming the glossary word or lesson. */
export function explainTopicWords(
  topic: ExplainTopic,
  context: Readonly<Record<string, string>>,
): string {
  const id =
    (topic === 'glossary_term' ? context.term : topic === 'lesson' ? context.lesson : '') ?? '';
  const name = id.replace(/[-_]+/g, ' ').trim();
  const words = name
    ? topic === 'glossary_term'
      ? `the word "${name}"`
      : `the lesson "${name}"`
    : TOPIC_WORDS[topic];
  return words.slice(0, 60);
}

/** The values already on screen, one per line (sent as untrusted data, at most 2,000 characters). */
export function explainScreenText(context: Readonly<Record<string, string>>): string | undefined {
  const lines = Object.entries(context)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}: ${v}`);
  return lines.length ? lines.join('\n').slice(0, 2000) : undefined;
}

export function NoviceExplainThis({ topic, context, locale, label }: ExplainSlotProps) {
  const { t } = useI18n();
  return (
    <CopilotExplain
      topic={explainTopicWords(topic, context)}
      screenText={explainScreenText(context)}
      context={{ panel: `novice_${topic}` }}
      label={label ?? t('explain.button')}
      busyLabel={t('explain.busy')}
      failedText={t('explain.failed')}
      note={locale === 'en' ? undefined : t('explain.english')}
    />
  );
}
