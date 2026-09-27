import { Module, type OnModuleInit } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { IntelPortRegistry } from '../ai/intel-port';
import { MarketDataModule } from '../market-data/market-data.module';
import { QuantClient } from '../sim/quant.client';
import { AlertsService } from './alerts.service';
import { IntelController } from './intel.controller';
import { IntelReadService } from './intel-read.service';
import { NewsService } from './news.service';
import { ScanService } from './scan.service';

/** Goal 07B: market intelligence (scanner, forecasts, news, Market Radar). ADR 0007B. */
@Module({
  imports: [MarketDataModule, AiModule],
  providers: [IntelReadService, ScanService, NewsService, AlertsService, QuantClient],
  controllers: [IntelController],
  exports: [IntelReadService],
})
export class IntelModule implements OnModuleInit {
  constructor(
    private readonly port: IntelPortRegistry,
    private readonly read: IntelReadService,
  ) {}

  /** IRTC R6-02: hand the copilot tools the read-only intel port (no dynamic provider lookup). */
  onModuleInit(): void {
    this.port.bind(this.read);
  }
}
