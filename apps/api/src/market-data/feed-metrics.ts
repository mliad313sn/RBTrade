import { Injectable, type OnModuleInit } from '@nestjs/common';

import { OpsMetrics } from '../observability/ops-metrics.service';
import { ChannelHub } from './channel-hub';

/** Scrape-time feed health gauges from the last `status` message (goal 10, feed dashboard + alerts). */
@Injectable()
export class FeedMetrics implements OnModuleInit {
  constructor(
    private readonly metrics: OpsMetrics,
    private readonly hub: ChannelHub,
  ) {}

  onModuleInit(): void {
    this.metrics.onScrape(() => {
      const s = this.hub.lastStatus();
      if (!s) return;
      this.metrics.feedStatusAge.set(Math.max(0, (Date.now() - s.ts) / 1000));
      this.metrics.feedStaleSymbols.set(s.staleSymbols.length);
      for (const f of s.feeds)
        if (f.state !== 'disabled')
          this.metrics.feedUp.set({ source: f.source }, f.state === 'up' ? 1 : 0);
    });
  }
}
