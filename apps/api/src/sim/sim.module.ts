import { Module } from '@nestjs/common';

import { QuantClient } from './quant.client';
import { SimController } from './sim.controller';

/** Gain simulator proxy (goal 05): zod validation, rate limit and audit in front of services/quant. */
@Module({ controllers: [SimController], providers: [QuantClient] })
export class SimModule {}
