import { Injectable } from '@nestjs/common';
import { dec, Decimal, type InstrumentSpec } from '@kora/domain';

import { MarketViewService } from './market-view.service';
import { TradingRegistryService } from './trading-registry.service';

export interface FxRate {
  from: string;
  to: string;
  /** Multiply an amount in `from` by this to get `to`. */
  rate: Decimal;
  /** Every quote on the path is fresh (not stale, within the asset-class threshold). */
  fresh: boolean;
  /** Registry symbols used, e.g. ['EURUSD'] or ['USDJPY', 'EURUSD'] (triangulated). */
  path: string[];
}

const PIVOT = 'USD';

/**
 * Currency conversion from live SIMULATED FX quotes in the registry (scope amendment: global,
 * multi-currency). Direct pair, inverse pair, or triangulation through USD. Mid prices; the
 * conversion fee is charged separately (fee schedule `fx_conversion_bps`).
 */
@Injectable()
export class FxService {
  constructor(
    private readonly registry: TradingRegistryService,
    private readonly market: MarketViewService,
  ) {}

  async rate(from: string, to: string, now = Date.now()): Promise<FxRate | null> {
    if (from === to) return { from, to, rate: new Decimal(1), fresh: true, path: [] };
    const pairs = await this.registry.fxPairs();
    const legs = this.route(pairs, from, to);
    if (!legs) return null;
    const quotes = await this.market.quotes(legs.map((l) => l.spec.symbol));
    let rate = new Decimal(1);
    let fresh = true;
    for (const leg of legs) {
      const q = quotes.get(leg.spec.symbol);
      if (!q) return null;
      const mid = dec(q.bid).add(dec(q.ask)).div(2);
      rate = rate.mul(leg.invert ? new Decimal(1).div(mid) : mid);
      const staleAfter = (await this.registry.find(leg.spec.symbol))?.staleAfterMs ?? 2000;
      if (q.stale || now - q.receivedTs > staleAfter) fresh = false;
    }
    return { from, to, rate, fresh, path: legs.map((l) => l.spec.symbol) };
  }

  private route(
    pairs: Map<string, InstrumentSpec>,
    from: string,
    to: string,
  ): Array<{ spec: InstrumentSpec; invert: boolean }> | null {
    const direct = (a: string, b: string) => {
      const d = pairs.get(`${a}/${b}`);
      if (d) return { spec: d, invert: false };
      const i = pairs.get(`${b}/${a}`);
      if (i) return { spec: i, invert: true };
      return null;
    };
    const one = direct(from, to);
    if (one) return [one];
    if (from === PIVOT || to === PIVOT) return null;
    const a = direct(from, PIVOT);
    const b = direct(PIVOT, to);
    return a && b ? [a, b] : null;
  }
}
