/**
 * @file queue.module.ts
 * @description 智能体全能平台 BullMQ 队列基础设施模块
 */

import { Global, Module } from '@nestjs/common';
import { QueueService } from './queue.service';

@Global()
@Module({
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
