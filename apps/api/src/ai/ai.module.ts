import { Module } from '@nestjs/common';

import { MarketDataModule } from '../market-data/market-data.module';
import { RobotsModule } from '../robots/robots.module';
import { QuantClient } from '../sim/quant.client';
import { StrategiesModule } from '../strategies/strategies.module';
import { TradingModule } from '../trading/trading.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { BudgetService, ResponseCacheService } from './budget.service';
import { CalibrationService } from './calibration.service';
import { DraftsService } from './drafts.service';
import { InsightsService } from './insights.service';
import { IntelPortRegistry } from './intel-port';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { AiReadPorts } from './read-ports';
import { StripService } from './strip.service';
import { AiToolBackend } from './tool-backend.service';

/** Goal 07: AI copilot gateway (explain, analyse, draft; never execute). ADR 0007. */
@Module({
  imports: [MarketDataModule, TradingModule, StrategiesModule, RobotsModule],
  providers: [
    AiReadPorts,
    AiService,
    AiToolBackend,
    BudgetService,
    ResponseCacheService,
    CalibrationService,
    DraftsService,
    InsightsService,
    IntelPortRegistry,
    StripService,
    MetricsService,
    QuantClient,
  ],
  controllers: [AiController, MetricsController],
  exports: [
    AiService,
    CalibrationService,
    MetricsService,
    DraftsService,
    BudgetService,
    IntelPortRegistry,
  ],
})
export class AiModule {}
