'use client';

import { KoraApiError, type NoviceProfile, type PendingLimit } from '@kora/sdk';
import { Button, Dialog, NumberInput, useToast } from '@kora/ui';
import Link from 'next/link';
import { useState } from 'react';

import { api } from '@/lib/api-browser';
import { hasKey, type MessageKey } from '@/lib/i18n';
import { Rich, useI18n } from '@/lib/i18n/react';

function Meter({ used, limit, label }: { used: string; limit: string | null; label: string }) {
  const ratio = limit && Number(limit) > 0 ? Math.min(1, Number(used) / Number(limit)) : 0;
  return (
    <div
      className="h-2 rounded-full bg-raised border border-border overflow-hidden"
      aria-hidden="true"
      title={label}
    >
      <div className="h-full bg-accent" style={{ width: `${(ratio * 100).toFixed(1)}%` }} />
    </div>
  );
}

function pendingText(
  p: PendingLimit,
  money: (v: string) => string,
  date: (iso: string) => string,
  t: ReturnType<typeof useI18n>['t'],
) {
  const key = `limits.pending.${p.field}`;
  return t(hasKey(key) ? (key as MessageKey) : 'limits.pending.other', {
    value: money(p.value),
    date: date(p.effectiveAt),
  });
}

/** Borrowing inside the limits dialog: off by default; asking needs the check and waits 24 h. */
function Borrowing({
  profile,
  onProfile,
}: {
  profile: NoviceProfile;
  onProfile: (p: NoviceProfile) => void;
}) {
  const { t, dateTime } = useI18n();
  const [busy, setBusy] = useState(false);
  const lev = profile.leverage;
  const set = async (enabled: boolean) => {
    setBusy(true);
    try {
      onProfile(await api.setNoviceLeverage(enabled));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="border-t border-border pt-4 mt-2" data-testid="borrowing">
      <h3 className="m-0 text-base">{t('borrow.title')}</h3>
      {lev.state === 'on' ? (
        <>
          <p className="m-0 mt-1">{t('borrow.on', { max: lev.current })}</p>
          <Button className="mt-2" disabled={busy} onClick={() => void set(false)}>
            {t('borrow.turnOff')}
          </Button>
        </>
      ) : lev.state === 'pending' ? (
        <>
          <p className="m-0 mt-1">{t('borrow.pending', { date: dateTime(lev.effectiveAt!) })}</p>
          <Button className="mt-2" disabled={busy} onClick={() => void set(false)}>
            {t('borrow.turnOff')}
          </Button>
        </>
      ) : !profile.knowledgeCheck.passed ? (
        <>
          <p className="m-0 mt-1">
            {t('borrow.off')} {t('borrow.needCheck')}
          </p>
          <Link href="/learn/check" className="k-btn mt-2 no-underline">
            {t('borrow.takeCheck')}
          </Link>
        </>
      ) : (
        <>
          <p className="m-0 mt-1">{t('borrow.askBody', { max: lev.max })}</p>
          <Button
            className="mt-2"
            disabled={busy}
            onClick={() => void set(true)}
            data-testid="ask-borrowing"
          >
            {t('borrow.ask')}
          </Button>
        </>
      )}
    </div>
  );
}

export function LimitsCard({
  profile,
  onProfile,
}: {
  profile: NoviceProfile | null;
  onProfile: (p: NoviceProfile) => void;
}) {
  const { t, money, dateTime } = useI18n();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [daily, setDaily] = useState('');
  const [monthly, setMonthly] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!profile) return null;
  const ccy = profile.currency;
  const m = (v: string) => money(v, ccy, { decimals: Number(v) % 1 === 0 ? 0 : 2 });
  const lim = profile.limits;
  const lev = profile.leverage;
  const borrowState =
    lev.state === 'on'
      ? t('limits.borrow.on', { max: lev.current })
      : lev.state === 'pending'
        ? t('limits.borrow.pending', { date: dateTime(lev.effectiveAt!) })
        : t('limits.borrow.off');

  const edit = () => {
    setDaily(lim.daily.limit);
    setMonthly(lim.monthly.limit ?? '');
    setError(null);
    setOpen(true);
  };
  const save = async () => {
    if (!(Number(daily) > 0) || !(Number(monthly) > 0)) return setError(t('limits.invalid'));
    if (Number(monthly) < Number(daily)) return setError(t('limits.monthlyLow'));
    setBusy(true);
    try {
      const p = await api.setNoviceLimits({ dailyLossLimit: daily, monthlyLossLimit: monthly });
      onProfile(p);
      toast.push(
        p.limits.pending.length > lim.pending.length ? t('limits.savedPending') : t('limits.saved'),
        'success',
        6000,
      );
      setOpen(false);
    } catch (e) {
      setError(e instanceof KoraApiError ? t('limits.invalid') : t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="k-panel" aria-labelledby="limits-title" data-testid="limits">
      <div className="k-panel__body">
        <h2 id="limits-title" className="k-panel__title m-0">
          {t('limits.title')}
        </h2>
        <p className="m-0 text-sm text-muted">{t('limits.subtitle')}</p>
        <div className="mt-3 flex flex-col gap-3">
          <div data-testid="limit-today">
            <div className="flex justify-between gap-2">
              <span>{t('limits.today')}</span>
              <span className="font-semibold k-num">
                {t('limits.of', { used: m(lim.daily.used), limit: m(lim.daily.limit) })}
              </span>
            </div>
            <Meter used={lim.daily.used} limit={lim.daily.limit} label={t('limits.today')} />
          </div>
          <div data-testid="limit-month">
            <div className="flex justify-between gap-2">
              <span>{t('limits.month')}</span>
              <span className="font-semibold k-num">
                {t('limits.of', {
                  used: m(lim.monthly.used),
                  limit: lim.monthly.limit ? m(lim.monthly.limit) : t('limits.notSet'),
                })}
              </span>
            </div>
            <Meter used={lim.monthly.used} limit={lim.monthly.limit} label={t('limits.month')} />
          </div>
        </div>
        {lim.pending.length ? (
          <ul className="m-0 mt-3 pl-5 text-sm" data-testid="pending-limits">
            {lim.pending.map((p) => (
              <li key={p.field}>{pendingText(p, m, dateTime, t)}</li>
            ))}
          </ul>
        ) : null}
        <p className="m-0 mt-3 text-sm text-muted" data-testid="borrowing-line">
          <Rich text={t('limits.borrowing', { state: borrowState })} />
          {lev.state === 'off' && !profile.knowledgeCheck.passed ? (
            <>
              {' · '}
              <Link href="/learn/check" className="text-accent">
                {t('limits.unlock')}
              </Link>
            </>
          ) : null}
        </p>
        <Button className="mt-3" onClick={edit} data-testid="edit-limits">
          {t('limits.edit')}
        </Button>
      </div>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t('limits.editTitle')}
        description={t('limits.editBody')}
        data-testid="limits-dialog"
      >
        <div className="flex flex-col gap-3">
          <NumberInput
            label={t('limits.daily')}
            value={daily}
            onValueChange={setDaily}
            precision={2}
            min="0"
            data-testid="limit-daily-input"
          />
          <NumberInput
            label={t('limits.monthly')}
            value={monthly}
            onValueChange={setMonthly}
            precision={2}
            min="0"
            data-testid="limit-monthly-input"
          />
          {error ? (
            <p className="k-error m-0" role="alert">
              {error}
            </p>
          ) : null}
          <div className="k-dialog__actions">
            <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void save()}
              data-testid="save-limits"
            >
              {t('common.save')}
            </Button>
          </div>
          <Borrowing profile={profile} onProfile={onProfile} />
        </div>
      </Dialog>
    </section>
  );
}
