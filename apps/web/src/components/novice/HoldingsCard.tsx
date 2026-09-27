'use client';

import { Button, Dialog, Panel, useToast } from '@kora/ui';
import type { NoviceSummary } from '@kora/sdk';
import { useState } from 'react';

import { refreshAccount } from '@/lib/account';
import { api } from '@/lib/api-browser';
import { useI18n } from '@/lib/i18n/react';
import { assetName } from '@/lib/novice/view';
import { displayDirection } from '@/lib/terminal/format';

const BADGE: Record<string, string> = {
  fx: 'FX',
  metal: 'Au',
  crypto: '₿',
  equity: 'SH',
  etf: 'ETF',
  fund: 'FD',
};

/** "What you own", in words: what it is, which way you gain, value and result so far. */
export function HoldingsCard({
  summary,
  onChange,
}: {
  summary: NoviceSummary | null;
  onChange: () => void;
}) {
  const { t, locale, money } = useI18n();
  const toast = useToast();
  const [closing, setClosing] = useState<{ symbol: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const holdings = summary?.holdings ?? [];
  const ccy = summary?.currency ?? 'USD';

  const close = async () => {
    if (!closing) return;
    setBusy(true);
    try {
      await api.closePosition(closing.symbol);
      toast.push(t('home.own.closed'), 'success', 5000);
      setClosing(null);
      refreshAccount();
      onChange();
    } catch {
      toast.push(t('common.error'), 'critical', 8000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title={t('home.own.title')} data-testid="holdings">
      {holdings.length === 0 ? (
        <p className="text-muted m-0">{t('home.own.empty')}</p>
      ) : (
        <ul className="list-none m-0 p-0">
          {holdings.map((h) => {
            const name = assetName(h.name, locale, h.displayName);
            const pnl = h.unrealizedPnl;
            // IRTC R5-19: no ▲ and no colour on $0.00 (direction from the rounded amount).
            const dir = pnl !== null ? displayDirection(pnl, 2) : 'flat';
            return (
              <li
                key={h.symbol}
                className="flex items-center gap-3 py-3 border-b border-border last:border-b-0"
                data-testid={`holding-${h.symbol}`}
              >
                <span
                  className="grid place-items-center w-10 h-10 rounded-lg bg-accent-surface text-accent text-xs font-bold shrink-0"
                  aria-hidden="true"
                >
                  {BADGE[h.assetClass] ?? h.symbol.slice(0, 3)}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block font-semibold truncate">{name}</span>
                  <span className="block text-sm text-muted">
                    {t(h.gainsIf === 'up' ? 'home.own.gainUp' : 'home.own.gainDown')}
                  </span>
                </span>
                <span className="text-right">
                  <span className="block k-num">
                    {h.value !== null ? money(h.value, ccy) : '—'}
                  </span>
                  {pnl !== null ? (
                    <span
                      className={`block text-sm k-num ${dir === 'up' ? 'text-up' : dir === 'down' ? 'text-down' : 'text-muted'}`}
                    >
                      <span aria-hidden="true">
                        {dir === 'up' ? '▲ ' : dir === 'down' ? '▼ ' : ''}
                      </span>
                      {money(pnl, ccy, { signed: true })}
                    </span>
                  ) : (
                    <span className="block text-sm text-muted">{t('home.own.paused')}</span>
                  )}
                </span>
                <Button
                  variant="ghost"
                  onClick={() => setClosing({ symbol: h.symbol, name })}
                  aria-label={t('home.own.closeAria', { name })}
                  data-testid={`close-${h.symbol}`}
                >
                  {t('home.own.close')}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <Dialog
        open={closing !== null}
        onOpenChange={(o) => !o && setClosing(null)}
        title={closing ? t('home.own.closeTitle', { name: closing.name }) : ''}
        description={t('home.own.closeBody')}
        data-testid="close-dialog"
      >
        <div className="k-dialog__actions">
          <Button onClick={() => setClosing(null)}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void close()}
            data-testid="confirm-close"
          >
            {t('home.own.closeConfirm')}
          </Button>
        </div>
      </Dialog>
    </Panel>
  );
}
