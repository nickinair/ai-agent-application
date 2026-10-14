/**
 * @file sealer.service.ts
 * @description 消息封组器核心服务（会话排他锁控制、按 sent_at 排序拼接、CRM 画像装配与 TurnContext 构造）
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §5.3、§7.4
 */

import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ENV, type Env } from '../../config/env';
import { RedisService } from '../../infra/redis/redis.service';
import { REDIS_KEYS } from '../../infra/redis/redis.keys';
import { QueueService, QUEUE_NAMES } from '../../infra/queue/queue.service';
import { MysqlService } from '../../database/mysql.service';
import { BufferService } from './buffer.service';
import { TimerService, type SealReason, type ISealer } from './timer.service';
import { CustomerContextService } from './customer-context.service';
import type { TurnContext, MessageRef } from '../../contracts';

export interface DbMessageRecord {
  id: number;
  tenant_id: number;
  conversation_id: number;
  group_id: number | null;
  channel: string;
  channel_msg_id: string;
  sender_role: string;
  sender_channel_user_id: string;
  sender_name?: string;
  msg_type: string;
  content?: string;
  media_url?: string;
  sent_at: Date;
}

export interface DbConversationRecord {
  id: number;
  tenant_id: number;
  channel: string;
  channel_chat_id: string;
  chat_name?: string;
  turn_count: number;
  customer_snapshot?: string;
  rule_pack_version: string;
}

@Injectable()
export class SealerService implements ISealer, OnModuleInit {
  private readonly logger = new Logger(SealerService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly redisService: RedisService,
    private readonly queueService: QueueService,
    private readonly mysqlService: MysqlService,
    private readonly bufferService: BufferService,
    private readonly timerService: TimerService,
    private readonly customerContextService: CustomerContextService,
  ) {}

  onModuleInit(): void {
    // 将自身注册给 TimerService，实现计时器到期回调
    this.timerService.setSealer(this);
  }

  /**
   * 封组核心逻辑
   * @param convId 会话 ID
   * @param senderId 发送人在渠道内的原生 ID
   * @param reason 封组触发原因 ('QUIET' | 'HARD' | 'COUNT' | 'HUMAN_TIMEOUT')
   * @returns 构造出的完整 TurnContext；若有在途组被拦截或无消息则返回 null
   */
  async seal(
    convId: number | string,
    senderId: string,
    reason: SealReason,
  ): Promise<TurnContext | null> {
    const lockKey = REDIS_KEYS.convLock(convId);
    // 抢占分布式排他锁（waitMs = 0，非阻塞抢占）
    const lock = await this.redisService.acquireLock(lockKey, 15000);

    if (!lock) {
      this.logger.log(
        `⏳ 会话 [convId=${convId}] 当前已有在途组正在流水线中处理，本批消息留在缓冲池等待下一轮`,
      );
      return null;
    }

    try {
      // 1. 原子清空并取出该发送人的所有未封组消息 ID
      const msgIds = await this.bufferService.drain(convId, senderId);
      if (!msgIds || msgIds.length === 0) {
        await lock.release();
        return null;
      }

      this.logger.log(
        `📦 正在为会话 [convId=${convId}, senderId=${senderId}] 封组，提取消息 ${msgIds.length} 条 [原因=${reason}]`,
      );

      // 2. 查询消息详细内容并按 sent_at 严格升序排序
      const messages = await this.queryAndSortMessages(msgIds);
      if (messages.length === 0) {
        await lock.release();
        return null;
      }

      // 3. 组内文本按规范拼接（中文逗号连接，图片占位）
      const { groupText, isOnlyImage } = this.concatGroupText(messages);

      // 4. 读取会话详情并准备自增轮次
      const conv = await this.queryConversation(convId);
      const tenantId = conv.tenant_id;
      const turnSeq = conv.turn_count + 1;
      const isFirstTurn = turnSeq === 1;

      // 5. 插入 msg_group 组表记录与创建 turn 记录
      const groupId = await this.insertMsgGroup({
        tenantId,
        convId: Number(convId),
        senderChannelUserId: senderId,
        mergedText: groupText,
        messageCount: messages.length,
        sealReason: reason,
        firstMsgAt: messages[0].sent_at,
      });

      // 批量关联更新消息的 group_id
      await this.updateMessagesGroupId(msgIds, groupId);

      // 创建轮次记录
      const turnId = await this.insertTurn({
        tenantId,
        convId: Number(convId),
        seq: turnSeq,
        rulePackVersion: conv.rule_pack_version || 'v1.0.0',
      });

      // 6. 客户画像装配与快照更新
      const customer = await this.customerContextService.assembleCustomerProfile(conv.chat_name);
      await this.updateConversationCustomerSnapshot(convId, customer);

      // 7. 装配贯穿后续六道关的标准 TurnContext 模型
      const groupMessages: MessageRef[] = messages.map((m) => ({
        messageId: m.id,
        channelMsgId: m.channel_msg_id,
        senderRole: (m.sender_role as any) || 'CUSTOMER',
        text: m.content || '',
        sentAt: m.sent_at.getTime(),
        mediaUrl: m.media_url,
      }));

      const context: TurnContext = {
        traceId: randomUUID(),
        tenantId,
        conversationId: Number(convId),
        turnId,
        groupId,
        isFirstTurn,
        groupText,
        groupMessages,
        customer,
        background: {
          turns: [],
          profile: customer.vehicle ? { vehicle: customer.vehicle } : {},
          emotionTrack: ['calm'],
          unresolved: [],
          counters: {
            correctionTotal: 0,
            correctionConsecutive: 0,
            lowConfConsecutive: 0,
            emotionBurst: 0,
          },
          factCard: {
            inQuestion: customer.product || '业务咨询',
            answered: [],
            pending: [],
            customer: `${customer.name}${customer.vehicle ? `，${customer.vehicle}` : ''}`,
          },
        },
        rulePackVersion: conv.rule_pack_version || 'v1.0.0',
        timings: {
          sealedAt: Date.now(),
        },
      };

      // 8. 登记在途执行组状态
      const redis = this.redisService.getClient();
      await redis.hset(REDIS_KEYS.inflight(convId), {
        groupId: String(groupId),
        sealedAt: String(Date.now()),
        turnId: String(turnId),
      });

      // 9. 推入 turn 执行队列，交由下游流水线进行理解处理
      const turnQueue = this.queueService.getQueue(QUEUE_NAMES.turn);
      await turnQueue.add(
        'run',
        { groupId, turnId, context },
        { jobId: `turn:${groupId}:0` },
      );

      this.logger.log(
        `✅ 封组成功并推入流水线: convId=${convId}, turnId=${turnId}, groupId=${groupId}, groupText="${groupText}"`,
      );

      return context;
    } catch (err: any) {
      await lock.release();
      this.logger.error(`封组执行异常: ${err.message}`, err.stack);
      throw err;
    }
  }

  /**
   * 轮次执行完成回调（onTurnDone）：释放锁并重新拉起滞留消息计时
   */
  async onTurnDone(convId: number | string): Promise<void> {
    const redis = this.redisService.getClient();
    await redis.del(REDIS_KEYS.inflight(convId));

    // 释放会话锁
    const lockKey = REDIS_KEYS.convLock(convId);
    await redis.del(lockKey);

    // 重新扫描剩余滞留发送人
    const nonEmpties = await this.bufferService.nonEmptySenders(convId);
    for (const sender of nonEmpties) {
      const meta = await this.bufferService.bumpVersion(convId, sender);
      // 以轮结束时间为基准重新预约静默
      await this.timerService.scheduleQuiet(convId, sender, meta.version, this.env.QUIET_WINDOW_MS);

      // 若滞留消息已经超过熔断时限，直接强制封组
      if (Date.now() - meta.firstAt >= this.env.HARD_TIMEOUT_MS) {
        await this.seal(convId, sender, 'HARD');
      }
    }
  }

  /**
   * 组内消息文本拼接（方案 §5.3）：
   * - 按 sent_at 升序，中文逗号连接文本；
   * - 图片消息在组内以 [图片] 占位。
   */
  concatGroupText(messages: DbMessageRecord[]): { groupText: string; isOnlyImage: boolean } {
    const pieces: string[] = [];
    let imageCount = 0;

    for (const m of messages) {
      if (m.msg_type === 'image') {
        pieces.push('[图片]');
        imageCount++;
      } else if (m.content) {
        pieces.push(m.content.trim());
      }
    }

    const groupText = pieces.join('，');
    const isOnlyImage = imageCount === messages.length && imageCount > 0;

    return { groupText, isOnlyImage };
  }

  private async queryAndSortMessages(ids: string[]): Promise<DbMessageRecord[]> {
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(',');
    const sql = `
      SELECT id, tenant_id, conversation_id, group_id, channel, channel_msg_id,
             sender_role, sender_channel_user_id, sender_name, msg_type, content, media_url, sent_at
      FROM message
      WHERE id IN (${placeholders})
      ORDER BY sent_at ASC
    `;

    const pool = this.mysqlService.getPool();
    const [rows] = await pool.query<any[]>(sql, ids);
    return (rows as DbMessageRecord[]) || [];
  }

  private async queryConversation(convId: number | string): Promise<DbConversationRecord> {
    const pool = this.mysqlService.getPool();
    const sql = `
      SELECT id, tenant_id, channel, channel_chat_id, chat_name, turn_count, customer_snapshot, rule_pack_version
      FROM conversation
      WHERE id = ?
    `;
    const [rows] = await pool.query<any[]>(sql, [convId]);
    if (!rows || rows.length === 0) {
      throw new Error(`会话未找到: convId=${convId}`);
    }
    return rows[0] as DbConversationRecord;
  }

  private async insertMsgGroup(data: {
    tenantId: number;
    convId: number;
    senderChannelUserId: string;
    mergedText: string;
    messageCount: number;
    sealReason: string;
    firstMsgAt: Date;
  }): Promise<number> {
    const pool = this.mysqlService.getPool();
    const sql = `
      INSERT INTO msg_group (
        tenant_id, conversation_id, sender_channel_user_id,
        status, merged_text, message_count, seal_reason, first_msg_at, sealed_at
      ) VALUES (?, ?, ?, 'UNDERSTANDING', ?, ?, ?, ?, NOW(3))
    `;
    const [res] = await pool.query<any>(sql, [
      data.tenantId,
      data.convId,
      data.senderChannelUserId,
      data.mergedText,
      data.messageCount,
      data.sealReason,
      data.firstMsgAt,
    ]);
    return res.insertId;
  }

  private async updateMessagesGroupId(ids: string[], groupId: number): Promise<void> {
    if (ids.length === 0) return;
    const pool = this.mysqlService.getPool();
    const placeholders = ids.map(() => '?').join(',');
    const sql = `UPDATE message SET group_id = ? WHERE id IN (${placeholders})`;
    await pool.query(sql, [groupId, ...ids]);
  }

  private async insertTurn(data: {
    tenantId: number;
    convId: number;
    seq: number;
    rulePackVersion: string;
  }): Promise<number> {
    const pool = this.mysqlService.getPool();
    const sql = `
      INSERT INTO turn (
        tenant_id, conversation_id, seq, status, responder, rule_pack_version, started_at
      ) VALUES (?, ?, ?, 'IN_PROGRESS', 'BOT', ?, NOW(3))
    `;
    const [res] = await pool.query<any>(sql, [
      data.tenantId,
      data.convId,
      data.seq,
      data.rulePackVersion,
    ]);

    // 同步更新会话 turn_count
    await pool.query(
      `UPDATE conversation SET turn_count = ? WHERE id = ?`,
      [data.seq, data.convId],
    );

    return res.insertId;
  }

  private async updateConversationCustomerSnapshot(
    convId: number | string,
    snapshot: any,
  ): Promise<void> {
    const pool = this.mysqlService.getPool();
    const sql = `UPDATE conversation SET customer_snapshot = ? WHERE id = ?`;
    await pool.query(sql, [JSON.stringify(snapshot), convId]);
  }
}
