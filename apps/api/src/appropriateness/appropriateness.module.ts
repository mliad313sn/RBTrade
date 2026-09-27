import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { DisclosuresModule } from '../disclosures/disclosures.module';
import { AppropriatenessController } from './appropriateness.controller';
import { QuestionnaireService } from './questionnaire.service';

/** B-018: questionnaire engine + appropriateness assessment gating the `trader` role. */
@Module({
  imports: [AuthModule, DisclosuresModule],
  providers: [QuestionnaireService],
  controllers: [AppropriatenessController],
  exports: [QuestionnaireService],
})
export class AppropriatenessModule {}
