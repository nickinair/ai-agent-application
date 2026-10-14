import { Injectable } from '@nestjs/common';
import type { ChannelAdapter, OutboundMessage } from '../../contracts';
import { TestChannelRecorder } from './test-channel.recorder';
import { WecomChannelAdapter } from './wecom-channel.adapter';

/** 全局 CHANNEL_ADAPTER：测试注入的会话（channel = 'test'）只记录不外发，其余经企微发出 */
@Injectable()
export class ChannelRouter implements ChannelAdapter {
  constructor(
    private readonly wecom: WecomChannelAdapter,
    private readonly test: TestChannelRecorder,
  ) {}

  send(msg: OutboundMessage): Promise<{ channelMsgId?: string }> {
    return msg.channel === 'test' ? this.test.send(msg) : this.wecom.send(msg);
  }
}
