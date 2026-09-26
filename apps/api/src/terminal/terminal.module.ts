import { Module } from '@nestjs/common';

import { MarketDataModule } from '../market-data/market-data.module';
import { TradingModule } from '../trading/trading.module';
import { AlertsController } from './alerts.controller';
import { AlertsService } from './alerts.service';
import { LayoutsController } from './layouts.controller';
import { RiskController } from './risk.controller';
import { WatchlistsController } from './watchlists.controller';

/** Goal 04: Pro terminal state (layouts, watchlists), server-evaluated alerts and the risk summary (ADR 0004). */
@Module({
  imports: [MarketDataModule, TradingModule],
  providers: [AlertsService],
  controllers: [LayoutsController, WatchlistsController, AlertsController, RiskController],
  exports: [AlertsService],
})
export class TerminalModule {}
