import { Global, Module } from '@nestjs/common';
import { CHANNEL_ADAPTER } from '../../contracts';
import { PipelineModule } from '../pipeline/pipeline.module';
import { ReplyDispatcherService } from './reply-dispatcher.service';
import { WecomChannelAdapter } from './wecom-channel.adapter';

/**
 * 发送端：消费核心服务的回复并经企微发出。
 * 全局提供 CHANNEL_ADAPTER，运行时 FinalCheckService.safeSend 的发送也走这里。
 */
@Global()
@Module({
  imports: [PipelineModule],
  providers: [WecomChannelAdapter, { provide: CHANNEL_ADAPTER, useExisting: WecomChannelAdapter }, ReplyDispatcherService],
  exports: [CHANNEL_ADAPTER, ReplyDispatcherService],
})
export class ReplyModule {}
