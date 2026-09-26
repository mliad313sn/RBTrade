import '../env';

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { ConfigModule } from '../config/config.module';
import { DbModule } from '../db/db.module';
import { MarketDataFeedModule } from './feed.module';
import { FeedService } from './feed.service';

@Module({ imports: [ConfigModule, DbModule, MarketDataFeedModule] })
class FeedProcessModule {}

/** Standalone feed process: run the api with KORA_MD_FEED=off and this next to it. */
async function main(): Promise<void> {
  const ctx = await NestFactory.createApplicationContext(FeedProcessModule, { logger: ['log', 'warn', 'error'] });
  ctx.enableShutdownHooks();
  await ctx.get(FeedService).start();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
