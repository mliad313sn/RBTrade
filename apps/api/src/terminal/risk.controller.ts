import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  alignedDailyReturns,
  correlationClusters,
  dec,
  historicalVar,
  netExposureByCurrency,
  type Decimal,
} from '@kora/domain';

import { CurrentPrincipal } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { CandlesService } from '../market-data/candles.service';
import { AccountsService } from '../trading/accounts.service';
import { FxService } from '../trading/fx.service';
import { TradingRegistryService } from '../trading/trading-registry.service';

const VAR_LOOKBACK_DAYS = 250;

/**
 * Pro terminal Risk tab (goal 04): net exposure by currency, one-day historical VaR(95 %),
 * correlation clusters of held instruments, and daily loss against the limit.
 *
 * The quant service has no risk endpoint yet, so the api computes this with the unit-tested
 * `@kora/domain` risk analytics and labels it `source: 'api'` (moving it to the quant service
 * is B-401). History is the SIMULATED daily candles served by GET /candles.
 */
@ApiTags('terminal')
@Controller('risk')
export class RiskController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly registry: TradingRegistryService,
    private readonly fx: FxService,
    private readonly candles: CandlesService,
  ) {}

  @Get('summary')
  @ApiOperation({
    summary:
      'Net exposure by currency, historical VaR(95 %, 1 day), correlation clusters and daily loss vs limit (PAPER, SIMULATED history).',
  })
  async summary(@CurrentPrincipal() p: Principal) {
    const account = await this.accounts.ensure(p.sub);
    const base = account.base_currency;
    const [valuation, view] = await Promise.all([
      this.accounts.value(account),
      this.accounts.view(account),
    ]);

    const positions = [];
    for (const v of valuation.positions) {
      const inst = await this.registry.get(v.symbol);
      positions.push({ v, spec: inst.spec });
    }

    // Currency → base rates for every currency the book touches.
    const ccys = new Set<string>();
    for (const { spec } of positions) {
      ccys.add(spec.quoteCcy);
      if (spec.baseCcy) ccys.add(spec.baseCcy);
    }
    const rates = new Map<string, Decimal | null>();
    for (const c of ccys) rates.set(c, (await this.fx.rate(c, base))?.rate ?? null);

    const exposure = netExposureByCurrency(
      positions
        .filter(({ v }) => v.mark)
        .map(({ v, spec }) => ({
          symbol: v.symbol,
          qty: v.qty.toFixed(),
          price: v.mark!.toFixed(),
          multiplier: v.multiplier.toFixed(),
          baseCcy:
            spec.assetClass === 'fx' || spec.assetClass === 'metal' || spec.assetClass === 'crypto'
              ? spec.baseCcy
              : null,
          quoteCcy: spec.quoteCcy,
        })),
      (c) => rates.get(c) ?? null,
    );

    // Daily returns of each held instrument (SIMULATED history), aligned by date with the forming
    // daily bar dropped (IRTC R3-08): calendars differ across venues (24/7 crypto vs weekday index).
    const closes: Record<string, Array<{ t: number; close: number }>> = {};
    for (const { v } of positions) {
      const { candles } = await this.candles.get({
        symbol: v.symbol,
        tf: '1D',
        limit: VAR_LOOKBACK_DAYS + 2,
      });
      closes[v.symbol] = candles.map((c) => ({ t: c.t, close: Number(c.close) }));
    }
    const returns = alignedDailyReturns(closes, { now: Date.now(), tfMs: 86_400_000 });
    const valued = positions
      .filter(({ v }) => v.mark && v.fxRate)
      .map(({ v }) => ({
        symbol: v.symbol,
        valueBase: Number(v.qty.mul(v.mark!).mul(v.multiplier).mul(v.fxRate!).toFixed(2)),
      }));
    const var95 = historicalVar({
      positions: valued,
      returns,
      confidence: 0.95,
      maxObservations: VAR_LOOKBACK_DAYS,
    });
    const correlation = correlationClusters(returns, 0.7);
    const equity = dec(view.equity);

    return {
      accountId: account.id,
      currency: base,
      simulated: true,
      source: 'api' as const,
      asOf: new Date().toISOString(),
      exposure,
      var: {
        ...var95,
        pctEquity:
          var95.value && equity.gt(0)
            ? dec(var95.value).div(equity).mul(100).toDecimalPlaces(2).toFixed(2)
            : null,
        note:
          var95.value === null
            ? `Not enough daily history (${var95.observations}/${var95.required} days).`
            : 'Historical simulation on SIMULATED daily closes.',
      },
      correlation,
      dailyLoss: {
        dayPnl: view.dayPnl,
        limit: view.dailyLossLimit,
        usedPct: view.dailyLossUsedPct,
      },
    };
  }
}
