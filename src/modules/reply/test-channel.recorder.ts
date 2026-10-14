import { Injectable } from '@nestjs/common';
import type { ChannelAdapter, OutboundMessage } from '../../contracts';
import { RedisService } from '../../infra/redis/redis.service';

const MAX_PER_CHAT = 200;
const TTL_S = 24 * 3600;
const key = (chatId: string) => `ag:test:sent:${chatId}`;

export type RecordedMessage = OutboundMessage & { sentAt: number };

/**
 * 测试渠道（channel = 'test'，测试注入接口进来的会话）：不真正发送，把机器人发出的消息按群记到 Redis，
 * 供 /test/conversations/{chatId}/trace 读取。存 Redis 是为了多实例时哪台发的都能读到。
 */
@Injectable()
export class TestChannelRecorder implements ChannelAdapter {
  readonly channel = 'test' as const;

  constructor(private readonly redis: RedisService) {}

  async send(msg: OutboundMessage): Promise<{ channelMsgId: string }> {
    const r = this.redis.getClient();
    const k = key(msg.channelChatId);
    const sentAt = Date.now();
    await r.multi().rpush(k, JSON.stringify({ ...msg, sentAt })).ltrim(k, -MAX_PER_CHAT, -1).expire(k, TTL_S).exec();
    return { channelMsgId: `test-out-${sentAt}` };
  }

  async sentTo(chatId: string): Promise<RecordedMessage[]> {
    const rows = await this.redis.getClient().lrange(key(chatId), 0, -1);
    return rows.map((r) => JSON.parse(r) as RecordedMessage);
  }
}
