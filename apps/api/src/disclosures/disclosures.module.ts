import { Module } from '@nestjs/common';

import { DisclosureAcknowledgements } from './acknowledgements.service';
import { DbDisclosureRegistry } from './db-disclosure-registry';
import { DISCLOSURE_REGISTRY } from './disclosure.types';
import { DisclosuresController } from './disclosures.controller';

/**
 * Disclosures (goal 08 interface, goal 09 registry). Goal 09 swapped the `DISCLOSURE_REGISTRY` provider
 * to the Compliance-owned database registry; `DisclosureAcknowledgements` and callers are unchanged.
 */
@Module({
  providers: [
    // Goal 09: the Compliance-owned, versioned, per-jurisdiction registry (database-backed).
    DbDisclosureRegistry,
    { provide: DISCLOSURE_REGISTRY, useExisting: DbDisclosureRegistry },
    DisclosureAcknowledgements,
  ],
  controllers: [DisclosuresController],
  exports: [DISCLOSURE_REGISTRY, DbDisclosureRegistry, DisclosureAcknowledgements],
})
export class DisclosuresModule {}
