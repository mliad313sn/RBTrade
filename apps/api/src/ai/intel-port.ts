import { Injectable, ServiceUnavailableException } from '@nestjs/common';

import type { IntelReadService } from '../intel/intel-read.service';

/** The three goal 07B reads the copilot may call. Nothing else of the intel module is reachable. */
export type IntelReadPort = Pick<IntelReadService, 'radar' | 'trendCard' | 'news'>;

/**
 * IRTC R6-02: the intel module depends on the AI module, so the copilot cannot inject the intel read
 * service directly. Instead of a dynamic provider lookup (which could resolve any provider), the
 * intel module binds its read service here at start-up and the tools see only `IntelReadPort`.
 */
@Injectable()
export class IntelPortRegistry {
  private impl: IntelReadPort | null = null;

  bind(impl: IntelReadPort): void {
    this.impl = impl;
  }

  get(): IntelReadPort {
    if (!this.impl) throw new ServiceUnavailableException('Market intelligence is not available.');
    return this.impl;
  }
}
