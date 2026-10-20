import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { ChannelAdapter, OutboundMessage } from '../../contracts';
import { WecomBotService } from '../wecom/wecom-bot.service';

const RETRIES = 2;
const RETRY_DELAY_MS = 300;

/**
 * 群消息正文。智能机器人主动推送（aibot_send_msg）的 markdown 不认 <@userid>，会原样显示成「<@NiKai>」，
 * 所以只发正文，不带 @ 标记。
 */
export function renderWecomMarkdown(msg: Pick<OutboundMessage, 'text'>): string {
  return msg.text ?? '';
}

/**
 * 企微渠道发送（方案 §11.1 ChannelAdapter）：经运行时已建立的智能机器人长连接主动推送（aibot_send_msg）。
 * 群消息发到 channelChatId，私信（交接包）发到 toUserId。失败重试 2 次（间隔 300ms），仍失败抛出由调用方记“发送失败”。
 * 长连接服务在发送时再取：它经消息处理依赖入站流水线，而入站流水线又注入本适配器，构造时注入会循环依赖。
 */
@Injectable()
export class WecomChannelAdapter implements ChannelAdapter {
  readonly channel = 'wecom_group' as const;
  private readonly logger = new Logger(WecomChannelAdapter.name);

  private bot?: WecomBotService;

  constructor(private readonly moduleRef: ModuleRef) {}

  async send(msg: OutboundMessage): Promise<{ channelMsgId?: string }> {
    this.bot ??= this.moduleRef.get(WecomBotService, { strict: false });
    const client = this.bot.getClient();
    if (!client) throw new Error('企微智能机器人长连接未建立，无法发送');
    const target = msg.toUserId ?? msg.channelChatId;
    if (!target) throw new Error('缺少发送目标（群 ID 或成员 ID）');
    let lastErr: unknown;
    for (let i = 0; i <= RETRIES; i++) {
      try {
        const frame = await client.sendMessage(target, { msgtype: 'markdown', markdown: { content: renderWecomMarkdown(msg) } });
        return { channelMsgId: (frame as { headers?: { req_id?: string } })?.headers?.req_id };
      } catch (err) {
        lastErr = err;
        this.logger.warn(`发送失败（第 ${i + 1} 次）→ ${target}：${(err as Error).message}`);
        if (i < RETRIES) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
