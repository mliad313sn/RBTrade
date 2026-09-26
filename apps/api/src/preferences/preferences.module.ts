import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { MeController } from './me.controller';
import { PreferencesRepository } from './preferences.repository';

@Module({ imports: [AuthModule], providers: [PreferencesRepository], controllers: [MeController] })
export class PreferencesModule {}
