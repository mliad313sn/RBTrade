import { Module } from '@nestjs/common';

import { AppropriatenessModule } from '../appropriateness/appropriateness.module';
import { AuthModule } from '../auth/auth.module';
import { DisclosuresModule } from '../disclosures/disclosures.module';
import { RobotsModule } from '../robots/robots.module';
import { StrategiesModule } from '../strategies/strategies.module';
import { TradingModule } from '../trading/trading.module';
import { AutoInvestService } from './auto-invest.service';
import { MfaOptInController } from './mfa-opt-in.controller';
import { loadNoviceConfig, NOVICE_CONFIG } from './novice-config';
import { NoviceController } from './novice.controller';
import { NoviceService } from './novice.service';

/** Goal 08: Novice view API (onboarding, limits, ticket, knowledge check, auto-invest, MFA opt-in). */
@Module({
  imports: [
    AuthModule,
    TradingModule,
    AppropriatenessModule,
    DisclosuresModule,
    StrategiesModule,
    RobotsModule,
  ],
  providers: [
    { provide: NOVICE_CONFIG, useFactory: () => loadNoviceConfig() },
    NoviceService,
    AutoInvestService,
  ],
  controllers: [NoviceController, MfaOptInController],
  exports: [NoviceService],
})
export class NoviceModule {}
