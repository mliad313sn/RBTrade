import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';

import { AdminController } from './admin/admin.controller';
import { AiModule } from './ai/ai.module';
import { AppropriatenessModule } from './appropriateness/appropriateness.module';
import { AuditModule } from './audit/audit.module';
import { AuthGuard } from './auth/auth.guard';
import { AuthModule } from './auth/auth.module';
import { ObservabilityModule } from './observability/observability.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { ComplianceModule } from './compliance/compliance.module';
import { ConfigModule } from './config/config.module';
import { DbModule } from './db/db.module';
import { DisclosuresModule } from './disclosures/disclosures.module';
import { GovernanceCoreModule } from './governance/governance-core.module';
import { GovernanceModule } from './governance/governance.module';
import { HealthController } from './health/health.controller';
import { IntelModule } from './intel/intel.module';
import { MarketDataModule } from './market-data/market-data.module';
import { NoviceModule } from './novice/novice.module';
import { PreferencesModule } from './preferences/preferences.module';
import { RobotsModule } from './robots/robots.module';
import { SimModule } from './sim/sim.module';
import { TerminalModule } from './terminal/terminal.module';
import { StrategiesModule } from './strategies/strategies.module';
import { TradingModule } from './trading/trading.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        autoLogging: { ignore: (req) => req.url === '/health' },
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'res.headers["set-cookie"]',
            '*.password',
            '*.code',
            '*.secret',
            '*.mfaToken',
            '*.accessToken',
            '*.recoveryCode',
            '*.recoveryCodes',
          ],
          censor: '[redacted]',
        },
        customProps: () => ({ service: 'kora-api', env: 'PAPER' }),
      },
    }),
    // Per-client default for every route (KORA_API_RATE_LIMIT per minute, read per request; goal 10 load runs raise it).
    ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 60_000, limit: () => Number(process.env.KORA_API_RATE_LIMIT ?? 600) || 600 }] }),
    DbModule,
    // Goal 10: shared Prometheus registry and operational metrics (global).
    ObservabilityModule,
    AuditModule,
    // Goal 09: governance settings and the four-eyes store (global; used by the trading core).
    GovernanceCoreModule,
    AuthModule,
    PreferencesModule,
    MarketDataModule,
    SimModule,
    TradingModule,
    AppropriatenessModule,
    TerminalModule,
    StrategiesModule,
    RobotsModule,
    AiModule,
    IntelModule,
    // Goal 08: Novice view and the disclosures interface (goal 09 owns the registry).
    DisclosuresModule,
    NoviceModule,
    // Goal 09: risk, compliance and governance layer (ADR 0009).
    GovernanceModule,
    ComplianceModule,
  ],
  controllers: [HealthController, AdminController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
