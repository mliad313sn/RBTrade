import { Module } from '@nestjs/common';

import { AppropriatenessModule } from '../appropriateness/appropriateness.module';
import { DisclosuresModule } from '../disclosures/disclosures.module';
import {
  ComplianceController,
  MeComplianceController,
  SuitabilityController,
} from './compliance.controller';
import { KYC_PROVIDER, StubKycProvider } from './kyc';
import { SubjectAccessService } from './subject-access.service';
import { SuitabilityService } from './suitability.service';

/** Goal 09 compliance hooks: disclosures registry tooling, suitability, KYC stub, best execution, subject access. */
@Module({
  imports: [AppropriatenessModule, DisclosuresModule],
  providers: [
    SuitabilityService,
    SubjectAccessService,
    { provide: KYC_PROVIDER, useValue: new StubKycProvider() },
  ],
  controllers: [ComplianceController, MeComplianceController, SuitabilityController],
  exports: [SuitabilityService],
})
export class ComplianceModule {}
