import { Body, Controller, Get, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { RowDataPacket } from 'mysql2';
import { z } from 'zod';
import { parse } from '../../admin/validation';
import { Public } from '../../auth/tenant-context';
import { ENV, type Env } from '../../config/env';
import { MysqlService } from '../../database/mysql.service';
import { InboundPipelineService } from '../pipeline/inbound-pipeline.service';
import { TestChannelRecorder } from './test-channel.recorder';

const InjectSchema = z.object({
  tenantId: z.number().int().positive().optional(),
  chatId: z.string().min(1),
  chatName: z.string().optional(),
  sender: z.object({
    role: z.enum(['CUSTOMER', 'STAFF_CS', 'STAFF_OTHER', 'PARTNER']),
    userId: z.string().min(1),
    name: z.string().optional(),
  }),
  text: z.string().min(1),
  mentions: z.array(z.string()).default([]),
});

/**
 * 测试注入接口（§13.1，评审 C6；原在 ai-agent-gateway，网关下线后迁到这里）。
 * 以指定群、指定成员身份发一条消息，走与企微完全相同的运行时链路（缓冲池 → 封组 → 核心服务理解与回复 → 末检 → 发送）；
 * 测试会话的渠道是 test，机器人发出的消息只记录、不外发。只在 TEST_INJECT_ENABLED=true 时可用，生产关闭（否则一律 404）。
 */
@Public()
@Controller('test')
export class TestInjectController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly inbound: InboundPipelineService,
    private readonly recorder: TestChannelRecorder,
    private readonly mysql: MysqlService,
  ) {}

  @Post('inject')
  async inject(@Body() raw: unknown) {
    this.ensureEnabled();
    const body = parse(InjectSchema, raw);
    const channelMsgId = `test-${randomUUID()}`;
    const result = await this.inbound.onInbound({
      tenantId: body.tenantId ?? this.env.TEST_TENANT_ID ?? 1,
      channel: 'test',
      channelChatId: body.chatId,
      channelMsgId,
      chatName: body.chatName,
      sender: { role: body.sender.role, channelUserId: body.sender.userId, name: body.sender.name },
      mentions: body.mentions,
      type: 'text',
      text: body.text,
      sentAt: Date.now(),
    });
    return { channelMsgId, ...result };
  }

  /**
   * 该群机器人发出的消息，以及各组的处理情况（traceId 可再到核心服务 /test/trace/{traceId} 查各环节轨迹）。
   * traceId 在封组时才生成，所以注入接口拿不到，要从这里取。
   */
  @Get('conversations/:chatId/trace')
  async trace(@Param('chatId') chatId: string) {
    this.ensureEnabled();
    const [groups] = await this.mysql.getPool().query<RowDataPacket[]>(
      `SELECT g.id AS groupId, g.status, g.merged_text AS mergedText, g.sender_channel_user_id AS senderUserId,
              t.id AS turnId, t.reply_status AS replyStatus, t.seal_to_send_ms AS sealToSendMs,
              (SELECT l.trace_id FROM state_transition_log l
                WHERE l.entity_type = 'group' AND l.entity_id = g.id AND l.trace_id IS NOT NULL ORDER BY l.id DESC LIMIT 1) AS traceId,
              (SELECT JSON_ARRAYAGG(m.channel_msg_id) FROM message m WHERE m.group_id = g.id AND m.sender_role <> 'BOT') AS channelMsgIds
         FROM msg_group g
         JOIN conversation c ON c.id = g.conversation_id
         LEFT JOIN turn t ON t.id = g.turn_id
        WHERE c.channel = 'test' AND c.channel_chat_id = ?
        ORDER BY g.id`,
      [chatId],
    );
    return {
      chatId,
      botMessages: await this.recorder.sentTo(chatId),
      groups: groups.map((g) => ({ ...g, channelMsgIds: typeof g.channelMsgIds === 'string' ? JSON.parse(g.channelMsgIds) : g.channelMsgIds ?? [] })),
    };
  }

  private ensureEnabled(): void {
    if (!this.env.TEST_INJECT_ENABLED) throw new NotFoundException();
  }
}
