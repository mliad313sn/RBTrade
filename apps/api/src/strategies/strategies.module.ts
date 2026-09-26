import { Module } from '@nestjs/common';

import { MarketDataModule } from '../market-data/market-data.module';
import { TradingModule } from '../trading/trading.module';
import { BacktestsService } from './backtests.service';
import { ResearchClient } from './research-client';
import { ResearchDataService } from './research-data.service';
import {
  BacktestsController,
  StrategiesController,
  StrategyTemplatesController,
} from './strategies.controller';
import { StrategiesService } from './strategies.service';

/** Goal 06: strategy DSL versions, research runs (backtest, walk-forward, optimisation, heatmap), templates. */
@Module({
  imports: [MarketDataModule, TradingModule],
  providers: [StrategiesService, BacktestsService, ResearchDataService, ResearchClient],
  controllers: [StrategiesController, BacktestsController, StrategyTemplatesController],
  exports: [StrategiesService, BacktestsService, ResearchDataService, ResearchClient],
})
export class StrategiesModule {}
