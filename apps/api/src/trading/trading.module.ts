import { Module } from '@nestjs/common';

import { DisclosuresModule } from '../disclosures/disclosures.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';
import { EngineLoopService } from './engine-loop.service';
import { FxService } from './fx.service';
import { KillSwitchController } from './kill-switch.controller';
import { KillSwitchService } from './kill-switch.service';
import { LedgerService } from './ledger.service';
import { MarketViewService } from './market-view.service';
import { OmsService } from './oms.service';
import { OrdersController } from './orders.controller';
import { PaperEngineService } from './paper-engine.service';
import { ReconciliationService } from './reconciliation.service';
import { loadTradingConfig, TRADING_CONFIG } from './trading-config';
import { TradingEventsService } from './trading-events.service';
import { TradingPublisher } from './trading-publisher.service';
import { TradingRegistryService } from './trading-registry.service';

/** Goal 03: OMS, paper engine, pre-trade risk, kill switch, reconciliation (ADR 0003). */
@Module({
  imports: [MarketDataModule, DisclosuresModule],
  providers: [
    { provide: TRADING_CONFIG, useFactory: () => loadTradingConfig() },
    TradingRegistryService,
    MarketViewService,
    FxService,
    LedgerService,
    AccountsService,
    TradingEventsService,
    TradingPublisher,
    PaperEngineService,
    OmsService,
    EngineLoopService,
    KillSwitchService,
    ReconciliationService,
  ],
  controllers: [OrdersController, AccountsController, KillSwitchController],
  exports: [
    OmsService,
    AccountsService,
    TradingRegistryService,
    FxService,
    KillSwitchService,
    EngineLoopService,
    // Goal 08 (novice ticket and guardrails).
    MarketViewService,
    TRADING_CONFIG,
  ],
})
export class TradingModule {}
