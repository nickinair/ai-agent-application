import { Global, Module } from '@nestjs/common';
import { CHANNEL_ADAPTER } from '../../contracts';
import { PipelineModule } from '../pipeline/pipeline.module';
import { ChannelRouter } from './channel-router';
import { ReplyDispatcherService } from './reply-dispatcher.service';
import { TestChannelRecorder } from './test-channel.recorder';
import { TestInjectController } from './test-inject.controller';
import { WecomChannelAdapter } from './wecom-channel.adapter';

/**
 * 发送端：消费核心服务的回复并发出（企微；测试注入的会话只记录）。
 * 全局提供 CHANNEL_ADAPTER，运行时 FinalCheckService.safeSend 的发送也走这里。
 * 测试注入接口也在这里（TEST_INJECT_ENABLED=true 时可用）。
 */
@Global()
@Module({
  imports: [PipelineModule],
  controllers: [TestInjectController],
  providers: [
    WecomChannelAdapter,
    TestChannelRecorder,
    ChannelRouter,
    { provide: CHANNEL_ADAPTER, useExisting: ChannelRouter },
    ReplyDispatcherService,
  ],
  exports: [CHANNEL_ADAPTER, ReplyDispatcherService],
})
export class ReplyModule {}
