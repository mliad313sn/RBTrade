import { Module } from '@nestjs/common';

import { DisclosureAcknowledgements } from './acknowledgements.service';
import { ConfigDisclosureRegistry } from './config-disclosure-registry';
import { DISCLOSURE_REGISTRY } from './disclosure.types';
import { DisclosuresController } from './disclosures.controller';

/**
 * Disclosures (goal 08 interface, goal 09 registry). Swap the `DISCLOSURE_REGISTRY` provider to move
 * to the Compliance-owned registry; `DisclosureAcknowledgements` and callers stay unchanged.
 */
@Module({
  providers: [
    { provide: DISCLOSURE_REGISTRY, useFactory: () => new ConfigDisclosureRegistry(process.env) },
    DisclosureAcknowledgements,
  ],
  controllers: [DisclosuresController],
  exports: [DISCLOSURE_REGISTRY, DisclosureAcknowledgements],
})
export class DisclosuresModule {}
