'use client';

import { hasKey } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n/react';

/**
 * Risk level 1–5 as five bars; the level is also in the accessible name (colour is not the only cue).
 * IRTC R5-15: the fill uses the risk colour, not the "down" direction colour, so it never turns green
 * in the green/red or red-up conventions. IRTC R5-16: empty segments have a 3:1 outline, and
 * `showText` prints the level next to the bars.
 */
export function RiskBars({ level, label, showText = false }: { level: number; label: string; showText?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-x-2 gap-y-1 shrink-0 max-w-[9rem]">
      <span className="inline-flex gap-0.5" role="img" aria-label={label}>
        {[1, 2, 3, 4, 5].map((i) => (
          <span
            key={i}
            className={`w-2.5 h-3.5 rounded-sm border ${i <= level ? 'bg-risk border-risk' : 'bg-panel border-border-strong'}`}
          />
        ))}
      </span>
      {showText ? (
        <span className="text-xs text-muted text-right" aria-hidden="true">
          {label}
        </span>
      ) : null}
    </span>
  );
}

/** Template name/summary from the catalogue copy (falls back to the id). */
export function useTemplateText() {
  const { t } = useI18n();
  return (id: string, field: 'name' | 'summary') => {
    const k = `ai.t.${id}.${field}`;
    return hasKey(k) ? t(k) : id;
  };
}
