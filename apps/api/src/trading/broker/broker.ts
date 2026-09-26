import { dec, replayFills, type Decimal, type Side, type TradingEnvironment } from '@kora/domain';

/**
 * Execution venue abstraction (goal 03 §9). PAPER uses the internal engine; LIVE needs a licensed
 * broker (OQ-B1), `LIVE_TRADING_ENABLED=true` (refused by config in this build) and an active
 * compliance sign-off record. Market data adapters (goal 02) are a separate interface.
 */
export interface BrokerPosition {
  symbol: string;
  qty: Decimal;
  avgPrice: Decimal;
}

export interface BrokerExecutionAdapter {
  readonly name: string;
  readonly environment: TradingEnvironment;
  /** Positions as the broker sees them (reconciliation source). */
  positions(accountId: string): Promise<BrokerPosition[]>;
  submit(order: {
    accountId: string;
    clientOrderId: string;
    symbol: string;
    side: Side;
    qty: string;
    type: string;
  }): Promise<{ brokerOrderId: string }>;
  cancel(brokerOrderId: string): Promise<void>;
}

export class LiveTradingDisabledError extends Error {
  constructor(reason: string) {
    super(`LIVE trading is not enabled: ${reason}`);
    this.name = 'LiveTradingDisabledError';
  }
}

export interface FillSource {
  fillsFor(
    accountId: string,
    snapshot?: unknown,
  ): Promise<
    Array<{ symbol: string; side: Side; qty: string; price: string; multiplier: Decimal }>
  >;
}

/** Paper "broker": positions are an independent replay of the fills ledger. */
export class PaperBrokerAdapter implements BrokerExecutionAdapter {
  readonly name = 'paper-engine';
  readonly environment = 'PAPER' as const;

  constructor(private readonly source: FillSource) {}

  async positions(accountId: string, snapshot?: unknown): Promise<BrokerPosition[]> {
    const fills = await this.source.fillsFor(accountId, snapshot);
    const bySymbol = new Map<string, typeof fills>();
    for (const f of fills) bySymbol.set(f.symbol, [...(bySymbol.get(f.symbol) ?? []), f]);
    const out: BrokerPosition[] = [];
    for (const [symbol, list] of bySymbol) {
      const r = replayFills(
        list.map((f) => ({ side: f.side, qty: dec(f.qty), price: dec(f.price) })),
        list[0]!.multiplier,
      );
      out.push({ symbol, qty: r.position.qty, avgPrice: r.position.avgPrice });
    }
    return out;
  }

  async submit(): Promise<{ brokerOrderId: string }> {
    throw new Error('The paper engine executes in-process (OmsService); no external submission.');
  }

  async cancel(): Promise<void> {
    throw new Error('The paper engine executes in-process (OmsService); no external cancel.');
  }
}

/** Stub for a future licensed broker. Every call refuses; the guard documents the preconditions. */
export class LiveBrokerStub implements BrokerExecutionAdapter {
  readonly name = 'live-broker-stub';
  readonly environment = 'LIVE' as const;

  constructor(
    private readonly guard: {
      liveTradingEnabled: boolean;
      hasActiveSignoff: () => Promise<boolean>;
    },
  ) {}

  async assertEnabled(): Promise<void> {
    if (!this.guard.liveTradingEnabled)
      throw new LiveTradingDisabledError('LIVE_TRADING_ENABLED is false');
    if (!(await this.guard.hasActiveSignoff()))
      throw new LiveTradingDisabledError('no active compliance sign-off record');
    throw new LiveTradingDisabledError('no licensed broker adapter is configured (OQ-B1)');
  }

  async positions(): Promise<BrokerPosition[]> {
    await this.assertEnabled();
    return [];
  }

  async submit(): Promise<{ brokerOrderId: string }> {
    await this.assertEnabled();
    return { brokerOrderId: '' };
  }

  async cancel(): Promise<void> {
    await this.assertEnabled();
  }
}
