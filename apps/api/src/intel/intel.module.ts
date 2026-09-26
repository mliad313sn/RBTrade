import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { QuantClient } from '../sim/quant.client';
import { AlertsService } from './alerts.service';
import { IntelController } from './intel.controller';
import { IntelReadService } from './intel-read.service';
import { INTEL_READ } from './intel.tokens';
import { NewsService } from './news.service';
import { ScanService } from './scan.service';

/** Goal 07B: market intelligence (scanner, forecasts, news, Market Radar). ADR 0007B. */
@Module({
  imports: [MarketDataModule, AiModule],
  providers: [
    IntelReadService,
    { provide: INTEL_READ, useExisting: IntelReadService },
    ScanService,
    NewsService,
    AlertsService,
    QuantClient,
  ],
  controllers: [IntelController],
  exports: [IntelReadService],
})
export class IntelModule {}
