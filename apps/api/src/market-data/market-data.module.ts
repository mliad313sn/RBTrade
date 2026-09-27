import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { CandlesService } from './candles.service';
import { ChannelHub } from './channel-hub';
import { FeedMetrics } from './feed-metrics';
import { MarketDataFeedModule } from './feed.module';
import { MarketDataGateway } from './gateway';
import { InstrumentsController } from './instruments.controller';
import { MarketDataController } from './market-data.controller';

/** Goal 02: registry, feed (in-process or external), WebSocket gateway and REST reads. */
@Module({
  imports: [AuthModule, MarketDataFeedModule],
  providers: [ChannelHub, MarketDataGateway, CandlesService, FeedMetrics],
  controllers: [InstrumentsController, MarketDataController],
  exports: [MarketDataFeedModule, CandlesService, ChannelHub],
})
export class MarketDataModule {}
