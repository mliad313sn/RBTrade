import { Module } from '@nestjs/common';

import { TradingModule } from '../trading/trading.module';
import { QuantClient } from './quant.client';
import { SimScenariosController } from './scenarios.controller';
import { SimController } from './sim.controller';

/** Gain simulator proxy (goal 05): zod validation, rate limit and audit in front of services/quant. */
@Module({
  imports: [TradingModule],
  // Scenarios first: `/sim/scenarios` must not be shadowed by a parameterised sim route.
  controllers: [SimScenariosController, SimController],
  providers: [QuantClient],
})
export class SimModule {}
