import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';

import { AdminController } from './admin/admin.controller';
import { AuditModule } from './audit/audit.module';
import { AuthGuard } from './auth/auth.guard';
import { AuthModule } from './auth/auth.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { ConfigModule } from './config/config.module';
import { DbModule } from './db/db.module';
import { HealthController } from './health/health.controller';
import { KillSwitchController } from './kill-switch/kill-switch.controller';
import { PreferencesModule } from './preferences/preferences.module';
import { RobotsController } from './robots/robots.controller';
import { SimModule } from './sim/sim.module';

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
          ],
          censor: '[redacted]',
        },
        customProps: () => ({ service: 'kora-api', env: 'PAPER' }),
      },
    }),
    ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 60_000, limit: 600 }] }),
    DbModule,
    AuditModule,
    AuthModule,
    PreferencesModule,
    SimModule,
  ],
  controllers: [HealthController, KillSwitchController, RobotsController, AdminController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
