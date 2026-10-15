/**
 * @file placeholder.service.ts
 * @description 占位应答（方案 Q10、附录 C S1）：会话首条客户消息到达 ack_delay_ms（默认 500ms）后发一次占位语，
 *              让客户知道有人在处理；之后每轮不再发。人工持话筒、或机器人已回过话时不发。
 */

import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { RowDataPacket } from 'mysql2/promise';
import { MysqlService } from '../../database/mysql.service';
import { QueueService } from '../../infra/queue/queue.service';
import { RedisService } from '../../infra/redis/redis.service';
import { CHANNEL_ADAPTER, type ChannelAdapter, type ChannelType } from '../../contracts';
import { MicrophoneService } from './microphone.service';

export const ACK_QUEUE = 'agent.queue.ack';
const ONCE_TTL_S = 7 * 24 * 3600;
const DEFAULT_DELAY_MS = 500;
const DEFAULT_TEXTS = ['收到，我看一下', '好的，马上为您查'];

export interface AckJobData {
  tenantId: number;
  convId: number;
  senderId: string;
}

@Injectable()
export class PlaceholderService implements OnModuleInit {
  private readonly logger = new Logger(PlaceholderService.name);

  constructor(
    private readonly queueService: QueueService,
    private readonly mysqlService: MysqlService,
    private readonly redisService: RedisService,
    @Optional() private readonly microphoneService?: MicrophoneService,
    @Optional() @Inject(CHANNEL_ADAPTER) private readonly channelAdapter?: ChannelAdapter,
  ) {}

  onModuleInit(): void {
    this.queueService.createWorker<AckJobData>(ACK_QUEUE, (job: Job<AckJobData>) => this.fire(job.data), { concurrency: 20 });
  }

  /** 客户消息入池（话筒在机器人）时调用：每个会话只预约一次 */
  async onCustomerMessage(tenantId: number, convId: number, senderId: string): Promise<void> {
    const first = await this.redisService.getClient().set(`ag:ack:once:${convId}`, '1', 'EX', ONCE_TTL_S, 'NX');
    if (first !== 'OK') return;
    const delay = await this.delayMs(tenantId);
    await this.queueService
      .getQueue<AckJobData>(ACK_QUEUE)
      .add('ack', { tenantId, convId, senderId }, { jobId: `ack-${convId}`, delay, removeOnComplete: true, removeOnFail: 100 });
  }

  /** 到点：话筒仍在机器人、机器人还没回过话才发 */
  async fire(data: AckJobData): Promise<boolean> {
    if (this.microphoneService && (await this.microphoneService.getMicStatus(data.convId)).owner === 'HUMAN') return false;
    const pool = this.mysqlService.getPool();
    const [convRows] = await pool.query<RowDataPacket[]>(
      `SELECT channel, channel_chat_id, status FROM conversation WHERE id = ? AND tenant_id = ?`,
      [data.convId, data.tenantId],
    );
    const conv = convRows[0];
    if (!conv || conv.status !== 'ACTIVE') return false;
    const [bot] = await pool.query<RowDataPacket[]>(
      `SELECT 1 FROM message WHERE conversation_id = ? AND sender_role = 'BOT' LIMIT 1`,
      [data.convId],
    );
    if (bot.length) return false;

    const text = await this.pickText(data.tenantId);
    if (this.channelAdapter) {
      await this.channelAdapter.send({
        tenantId: data.tenantId,
        channel: conv.channel as ChannelType,
        channelChatId: conv.channel_chat_id,
        kind: 'PLACEHOLDER',
        text,
        mentions: [data.senderId],
        conversationId: data.convId,
      });
    }
    await pool.query(
      `INSERT INTO message (tenant_id, conversation_id, channel, channel_msg_id, sender_role, sender_channel_user_id, msg_type, content, is_placeholder, sent_at, received_at)
       VALUES (?, ?, ?, ?, 'BOT', 'bot', 'text', ?, 1, NOW(3), NOW(3))
       ON DUPLICATE KEY UPDATE id = id`,
      [data.tenantId, data.convId, conv.channel, `ack:${data.convId}`, text],
    );
    this.logger.log(`💬 [占位应答] 会话 #${data.convId} 已发占位语："${text}"`);
    return true;
  }

  /** 租户参数优先，平台默认（tenant_id = 0）其次 */
  private async delayMs(tenantId: number): Promise<number> {
    const [rows] = await this.mysqlService.getPool().query<RowDataPacket[]>(
      `SELECT param_value FROM rp_param WHERE tenant_id IN (0, ?) AND param_key = 'ack_delay_ms' ORDER BY tenant_id DESC LIMIT 1`,
      [tenantId],
    );
    const v = Number(rows[0]?.param_value);
    return Number.isFinite(v) && v >= 0 ? v : DEFAULT_DELAY_MS;
  }

  /** 规则包话术 ack（多条按权重随机）；租户没发布时用平台默认话术 */
  private async pickText(tenantId: number): Promise<string> {
    const [rows] = await this.mysqlService.getPool().query<RowDataPacket[]>(
      `SELECT tenant_id, content, weight FROM rp_script WHERE tenant_id IN (0, ?) AND script_key = 'ack' AND status = 1`,
      [tenantId],
    );
    const own = rows.filter((r) => Number(r.tenant_id) === tenantId);
    const pool = (own.length ? own : rows).map((r) => ({ text: String(r.content), weight: Math.max(1, Number(r.weight) || 1) }));
    if (!pool.length) return DEFAULT_TEXTS[Math.floor(Math.random() * DEFAULT_TEXTS.length)];
    let n = Math.random() * pool.reduce((s, r) => s + r.weight, 0);
    for (const r of pool) {
      n -= r.weight;
      if (n < 0) return r.text;
    }
    return pool[pool.length - 1].text;
  }
}
