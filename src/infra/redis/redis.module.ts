/**
 * @file redis.module.ts
 * @description 智能体全能平台 Redis 基础设施模块
 */

import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
