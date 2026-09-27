import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { DisclosuresModule } from '../disclosures/disclosures.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { RobotsModule } from '../robots/robots.module';
import { TradingModule } from '../trading/trading.module';
import { AlertsBridgeService } from './alerts-bridge.service';
import { AnchorsService } from './anchors.service';
import { ApprovalsController } from './approvals.controller';
import { EvidenceService } from './controls/evidence.service';
import { FourEyesService } from './four-eyes.service';
import { GovernanceController } from './governance.controller';
import { IncidentsService } from './incidents.service';
import { InternalAuditController } from './internal-audit.controller';
import { InternalAuditService } from './internal-audit.service';
import { ReleaseRecordService } from './release-record.service';
import { RiskConsoleController } from './risk-console.controller';
import { RiskConsoleService } from './risk-console.service';

/**
 * Goal 09 governance: four-eyes approvals, control catalogue and evidence export, risk officer
 * console (+ live alerts), internal audit (verification, anchors, sampling), ITIL 4 incidents,
 * retention report and the release record (ADR 0009).
 */
@Module({
  imports: [AuthModule, MarketDataModule, TradingModule, RobotsModule, DisclosuresModule],
  providers: [
    FourEyesService,
    AnchorsService,
    EvidenceService,
    IncidentsService,
    InternalAuditService,
    RiskConsoleService,
    AlertsBridgeService,
    ReleaseRecordService,
  ],
  controllers: [
    ApprovalsController,
    GovernanceController,
    InternalAuditController,
    RiskConsoleController,
  ],
  exports: [FourEyesService, EvidenceService, AnchorsService],
})
export class GovernanceModule {}
