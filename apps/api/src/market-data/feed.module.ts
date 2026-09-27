import { Module } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../config/config';
import { FeedService } from './feed.service';
import { InstrumentsRepository } from './instruments.repository';
import { loadMdConfig, MD_CONFIG } from './md-config';

/** Feed side only (used in-process by the api, or alone by `md:feed`). */
@Module({
  providers: [
    {
      provide: MD_CONFIG,
      useFactory: (app: AppConfig) => loadMdConfig(process.env, app.webOrigin),
      inject: [APP_CONFIG],
    },
    InstrumentsRepository,
    FeedService,
  ],
  exports: [MD_CONFIG, InstrumentsRepository, FeedService],
})
export class MarketDataFeedModule {}
