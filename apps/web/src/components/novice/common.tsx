'use client';

import { hasKey } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n/react';

/** Risk level 1–5 as five bars; the level is also in the accessible name (colour is not the only cue). */
export function RiskBars({ level, label }: { level: number; label: string }) {
  return (
    <span className="inline-flex gap-0.5" role="img" aria-label={label}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          className={`w-2.5 h-3.5 rounded-sm ${i <= level ? 'bg-down' : 'bg-border'}`}
        />
      ))}
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
