/**
 * @file inbound-pipeline.service.ts
 * @description 统一入站消息流水线处理服务（数据库唯一键幂等、身份识别、会话关联与缓冲池调度）
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §5.3、§7.3、§11.3
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, type Env } from '../../config/env';
import { MysqlService } from '../../database/mysql.service';
import { RedisService } from '../../infra/redis/redis.service';
import { REDIS_KEYS } from '../../infra/redis/redis.keys';
import { BufferService } from './buffer.service';
import { TimerService } from './timer.service';
import { SealerService } from './sealer.service';
import type { InboundMessage } from '../../contracts';

export interface InboundProcessResult {
  status: 'PROCESSED' | 'IGNORED_DUPLICATE' | 'IGNORED_BOT' | 'STAFF_HANDLED';
  messageId?: number;
  conversationId?: number;
  sealedDirectly?: boolean;
}

@Injectable()
export class InboundPipelineService {
  private readonly logger = new Logger(InboundPipelineService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly mysqlService: MysqlService,
    private readonly redisService: RedisService,
    private readonly bufferService: BufferService,
    private readonly timerService: TimerService,
    private readonly sealerService: SealerService,
  ) {}

  /**
   * 处理统一规范的入站消息（第 1 关「收」主入口）
   */
  async onInbound(msg: InboundMessage): Promise<InboundProcessResult> {
    // 1. 数据库幂等落库（基于 uk_channel_msg 唯一索引）
    const insertResult = await this.insertMessageIdempotent(msg);
    if (!insertResult.success) {
      this.logger.warn(
        `🛑 检测到渠道重复消息投递，执行幂等丢弃: channel=${msg.channel}, channelMsgId=${msg.channelMsgId}`,
      );
      return { status: 'IGNORED_DUPLICATE' };
    }

    const messageId = insertResult.messageId!;

    // 2. 获取或创建关联的活跃会话
    const conv = await this.getOrCreateActiveConversation(msg);
    const convId = conv.id;

    // 关联更新 message 表的 conversation_id
    await this.updateMessageConversationId(messageId, convId);

    // 3. 身份识别分流（方案 §11.3）
    const role = msg.sender.role;

    // ① 机器人自身发言：忽略
    if (role === 'BOT') {
      this.logger.debug(`忽略机器人自发消息: msgId=${messageId}`);
      return { status: 'IGNORED_BOT', messageId, conversationId: convId };
    }

    // ② 协作方人员：只落库留底，不触发问答与缓冲池
    if (role === 'PARTNER') {
      this.logger.debug(`生态伙伴发言，仅留库: msgId=${messageId}`);
      return { status: 'STAFF_HANDLED', messageId, conversationId: convId };
    }

    // ③ 专职客服或内部员工：触发话筒抢夺与转人工通知机制（§11.3）
    if (role === 'STAFF_CS' || role === 'STAFF_OTHER') {
      this.logger.log(
        `👔 内部员工/客服发言，标记话筒为人工持有: convId=${convId}, staffId=${msg.sender.channelUserId}`,
      );
      await this.handleStaffMessage(convId, msg);
      return { status: 'STAFF_HANDLED', messageId, conversationId: convId };
    }

    // ④ 外部客户消息（CUSTOMER）：进入缓冲池排队与双计时器调度
    const senderId = msg.sender.channelUserId;
    const meta = await this.bufferService.push(convId, senderId, messageId, msg.sentAt);

    this.logger.log(
      `📥 客户消息入缓冲池 [convId=${convId}, sender=${senderId}, count=${meta.count}, version=${meta.version}, isFirst=${meta.isFirst}]`,
    );

    // 检查是否达到条数阈值立即封组（默认 5 条）
    if (meta.count >= this.env.GROUP_MAX_MESSAGES) {
      this.logger.log(
        `⚡ 缓冲池条数达到上限 (${meta.count} >= ${this.env.GROUP_MAX_MESSAGES})，直接触发立即封组`,
      );
      await this.sealerService.seal(convId, senderId, 'COUNT');
      return {
        status: 'PROCESSED',
        messageId,
        conversationId: convId,
        sealedDirectly: true,
      };
    }

    // 预约 3 秒静默延迟封组检查（带最新版本号）
    await this.timerService.scheduleQuiet(convId, senderId, meta.version, this.env.QUIET_WINDOW_MS);

    // 如果是本轮首条入池消息，预约 15 秒熔断硬超时检查
    if (meta.isFirst) {
      await this.timerService.scheduleHard(convId, senderId, meta.epoch, this.env.HARD_TIMEOUT_MS);
    }

    return {
      status: 'PROCESSED',
      messageId,
      conversationId: convId,
      sealedDirectly: false,
    };
  }

  /**
   * 幂等写入 message 记录
   */
  private async insertMessageIdempotent(
    msg: InboundMessage,
  ): Promise<{ success: boolean; messageId?: number }> {
    const pool = this.mysqlService.getPool();
    const sql = `
      INSERT INTO message (
        tenant_id, conversation_id, channel, channel_msg_id,
        sender_role, sender_channel_user_id, sender_name,
        msg_type, content, media_url, sent_at, received_at
      ) VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3))
    `;

    try {
      const [res] = await pool.query<any>(sql, [
        msg.tenantId,
        msg.channel,
        msg.channelMsgId,
        msg.sender.role,
        msg.sender.channelUserId,
        msg.sender.name || null,
        msg.type,
        msg.text || null,
        msg.mediaUrl || null,
        new Date(msg.sentAt),
      ]);
      return { success: true, messageId: res.insertId };
    } catch (err: any) {
      // 捕获 MySQL 唯一键冲突错误码 ER_DUP_ENTRY (1062)
      if (err.errno === 1062 || err.code === 'ER_DUP_ENTRY') {
        return { success: false };
      }
      throw err;
    }
  }

  private async updateMessageConversationId(messageId: number, convId: number): Promise<void> {
    const pool = this.mysqlService.getPool();
    await pool.query(`UPDATE message SET conversation_id = ? WHERE id = ?`, [convId, messageId]);
  }

  /**
   * 查询活跃会话缓存或从数据库加载/初始化
   */
  async getOrCreateActiveConversation(msg: InboundMessage): Promise<{ id: number }> {
    const redis = this.redisService.getClient();
    const activeKey = REDIS_KEYS.activeConv(msg.tenantId, msg.channelChatId);

    const cachedConvId = await redis.get(activeKey);
    if (cachedConvId) {
      return { id: parseInt(cachedConvId, 10) };
    }

    const pool = this.mysqlService.getPool();
    // 查询最近未结束的活跃会话
    const [rows] = await pool.query<any[]>(
      `SELECT id FROM conversation
       WHERE tenant_id = ? AND channel_chat_id = ? AND status = 'ACTIVE'
       ORDER BY id DESC LIMIT 1`,
      [msg.tenantId, msg.channelChatId],
    );

    if (rows && rows.length > 0) {
      const convId = rows[0].id;
      await redis.set(activeKey, String(convId));
      return { id: convId };
    }

    // 创建全新活跃会话
    const [res] = await pool.query<any>(
      `INSERT INTO conversation (
         tenant_id, channel, channel_chat_id, chat_name,
         status, mic_owner, turn_count, rule_pack_version, started_at
       ) VALUES (?, ?, ?, ?, 'ACTIVE', 'BOT', 0, 'v1.0.0', NOW(3))`,
      [msg.tenantId, msg.channel, msg.channelChatId, msg.chatName || null],
    );

    const newConvId = res.insertId;
    await redis.set(activeKey, String(newConvId));
    return { id: newConvId };
  }

  /**
   * 处理人工客服发言（话筒抢夺）
   */
  private async handleStaffMessage(convId: number, msg: InboundMessage): Promise<void> {
    const pool = this.mysqlService.getPool();
    await pool.query(
      `UPDATE conversation SET mic_owner = 'HUMAN' WHERE id = ?`,
      [convId],
    );

    const redis = this.redisService.getClient();
    await redis.hset(REDIS_KEYS.mic(convId), {
      owner: 'HUMAN',
      staffId: msg.sender.channelUserId,
      seizedAt: String(Date.now()),
    });
  }
}
