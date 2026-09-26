import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { StrategiesModule } from '../strategies/strategies.module';
import { TradingModule } from '../trading/trading.module';
import { PromotionService } from './promotion.service';
import { RobotBookService } from './robot-book.service';
import { RobotControlService } from './robot-control.service';
import { RobotRuntimeService } from './robot-runtime.service';
import { RobotSupervisorService } from './robot-supervisor.service';
import { RobotTrackingService } from './robot-tracking.service';
import {
  InternalRobotsController,
  RobotReviewsController,
  RobotsController,
  SignalsController,
} from './robots.controller';
import { RobotsService } from './robots.service';
import { ServiceTokenGuard } from './service-token.guard';

/** Goal 06: robots, bot-runner internal API (B-301), supervision, tracking error, promotion. */
@Module({
  imports: [AuthModule, MarketDataModule, TradingModule, StrategiesModule],
  providers: [
    RobotsService,
    RobotBookService,
    RobotControlService,
    RobotRuntimeService,
    RobotSupervisorService,
    RobotTrackingService,
    PromotionService,
    ServiceTokenGuard,
  ],
  controllers: [
    RobotsController,
    RobotReviewsController,
    SignalsController,
    InternalRobotsController,
  ],
  exports: [RobotsService, RobotSupervisorService, RobotBookService],
})
export class RobotsModule {}
