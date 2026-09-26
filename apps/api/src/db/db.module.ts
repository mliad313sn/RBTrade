import { Global, Module } from '@nestjs/common';

import { DbService } from './db.service';
import { RedisService } from './redis.service';

@Global()
@Module({ providers: [DbService, RedisService], exports: [DbService, RedisService] })
export class DbModule {}
