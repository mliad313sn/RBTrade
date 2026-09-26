'use client';

import { useMemo } from 'react';

import { WhatsMovingCard } from '@/components/intel';
import { useI18n } from '@/lib/i18n/react';
import { assetName } from '@/lib/novice/view';

import { BalanceCard } from './BalanceCard';
import { HoldingsCard } from './HoldingsCard';
import { LimitsCard } from './LimitsCard';
import { AutoInvestCard, CoolingOffCard, LearnCard } from './SideCards';
import { TradeCard } from './TradeCard';
import { useNoviceData, type NoviceData } from './useNoviceData';

/**
 * Novice home (goal 08 §2–3, `design/prototype/Novice.png`): account and holdings | make a trade |
 * limits, auto-invest, learn. On phones (390 px first) it is one column: balance, trade, holdings,
 * what's moving (goal 07B card, localised), limits, auto-invest, learn.
 */
export function NoviceHome({ initial, symbol }: { initial: NoviceData; symbol: string }) {
  const { t, locale } = useI18n();
  const { data, reload } = useNoviceData(initial);
  const names = useMemo(
    () =>
      Object.fromEntries(
        (data.assets?.assets ?? []).map((a) => [a.symbol, assetName(a.name, locale, a.displayName)]),
      ),
    [data.assets, locale],
  );
  const profile = data.profile;
  const currency = profile?.currency ?? data.assets?.currency ?? 'USD';
  const col = 'flex flex-col gap-5 max-lg:contents';
  return (
    <div className="grid gap-5 lg:grid-cols-[1.15fr_1fr_0.85fr] items-start">
      <h1 className="k-sr-only">{t('home.title')}</h1>
      <div className={col}>
        <div className="max-lg:order-1">
          <BalanceCard summary={data.summary} />
        </div>
        <div className="max-lg:order-4">
          <HoldingsCard summary={data.summary} onChange={() => void reload()} />
        </div>
        <div className="max-lg:order-5">
          <WhatsMovingCard names={names} />
        </div>
      </div>
      <div className={col}>
        <div className="max-lg:order-2 empty:hidden">
          <CoolingOffCard profile={profile} />
        </div>
        <div className="max-lg:order-3">
          <TradeCard
            assets={data.assets?.assets ?? []}
            currency={currency}
            initialSymbol={symbol}
            coolingOff={!!profile?.coolingOff.active}
            onPlaced={() => void reload()}
          />
        </div>
      </div>
      <div className={col}>
        <div className="max-lg:order-6">
          <LimitsCard profile={profile} onProfile={() => void reload()} />
        </div>
        <div className="max-lg:order-7">
          <AutoInvestCard list={data.autoInvest} />
        </div>
        <div className="max-lg:order-8">
          <LearnCard />
        </div>
      </div>
    </div>
  );
}
