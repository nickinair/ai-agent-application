/**
 * @file inbound-pipeline.service.ts
 * @description 统一入站消息流水线处理服务（数据库唯一键幂等、身份识别、会话关联与缓冲池调度）
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §5.3、§7.3、§11.3
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ENV, type Env } from '../../config/env';
import { MysqlService } from '../../database/mysql.service';
import { RedisService } from '../../infra/redis/redis.service';
import { REDIS_KEYS } from '../../infra/redis/redis.keys';
import { BufferService } from './buffer.service';
import { TimerService } from './timer.service';
import { SealerService } from './sealer.service';
import { MicrophoneService } from './microphone.service';
import { PlaceholderService } from './placeholder.service';
import { StateTransitionService } from './state-transition.service';
import { CHANNEL_ADAPTER, type ChannelAdapter, type InboundMessage } from '../../contracts';
import type { RowDataPacket } from 'mysql2/promise';

export interface InboundProcessResult {
  status: 'PROCESSED' | 'IGNORED_DUPLICATE' | 'IGNORED_BOT' | 'STAFF_HANDLED';
  messageId?: number;
  conversationId?: number;
  sealedDirectly?: boolean;
}

@Injectable()
export class InboundPipelineService {
  private readonly logger = new Logger(InboundPipelineService.name);

  /**
   * 在途组生成任务的中断控制器映射 (groupId -> AbortController)
   */
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly mysqlService: MysqlService,
    private readonly redisService: RedisService,
    private readonly bufferService: BufferService,
    private readonly timerService: TimerService,
    private readonly sealerService: SealerService,
    @Optional() private readonly microphoneService?: MicrophoneService,
    @Optional() private readonly stateTransitionService?: StateTransitionService,
    @Optional() @Inject(CHANNEL_ADAPTER) private readonly channelAdapter?: ChannelAdapter,
    @Optional() private readonly placeholderService?: PlaceholderService,
  ) {}

  /**
   * 注册在途任务的 AbortController
   */
  registerAbortController(groupId: number | string, controller: AbortController): void {
    this.abortControllers.set(String(groupId), controller);
  }

  /**
   * 注销在途任务的 AbortController
   */
  unregisterAbortController(groupId: number | string): void {
    this.abortControllers.delete(String(groupId));
  }

  /**
   * 触发在途生成任务中断信号（尽力而为节省 LLM Token）
   */
  abortInflight(groupId: number | string): boolean {
    const controller = this.abortControllers.get(String(groupId));
    if (controller && !controller.signal.aborted) {
      controller.abort();
      this.abortControllers.delete(String(groupId));
      this.logger.log(`🛑 [InflightAbort] 成功中断在途组 #${groupId} 的生成任务`);
      return true;
    }
    return false;
  }

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

    // 刷新会话普通空闲计时器（对齐技术方案 §7.3 timers.resetIdle(conv)）
    await this.timerService?.scheduleIdle?.(convId, 'NORMAL');

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

    // ③ 检查是否显式 @机器人
    const botId = this.env.WECOM_BOT_ID;
    const hasMentionBot =
      msg.mentions?.some(
        (m) =>
          m === 'BOT' ||
          m.toLowerCase().includes('bot') ||
          (botId && m === botId) ||
          m === 'ai_assistant',
      ) ||
      Boolean(
        msg.text &&
          (msg.text.includes('@机器人') ||
            msg.text.includes('@小助理') ||
            msg.text.includes('@车和网') ||
            msg.text.includes('@智能') ||
            msg.text.toLowerCase().includes('@bot') ||
            msg.text.toLowerCase().includes('@ai') ||
            (botId && msg.text.includes(botId))),
      );

    // ③ 专职客服或内部员工：触发话筒抢夺与转人工通知机制（§11.3）
    if (role === 'STAFF_CS') {
      this.logger.log(
        `👔 专职客服发言，进入客服发言处理链路: convId=${convId}, staffId=${msg.sender.channelUserId}`,
      );
      await this.handleStaffMessage(convId, msg);
      return { status: 'STAFF_HANDLED', messageId, conversationId: convId };
    }

    if (role === 'STAFF_OTHER') {
      if (!hasMentionBot) {
        this.logger.log(
          `👔 内部员工未@机器人发言，标记话筒为人工持有: convId=${convId}, staffId=${msg.sender.channelUserId}`,
        );
        await this.handleStaffMessage(convId, msg);
        return { status: 'STAFF_HANDLED', messageId, conversationId: convId };
      }

      // 若内部员工 @机器人 发言：
      // 如果启用了交还话筒开关，走交接语下发流程
      if (this.env.MIC_RETURN_BY_MENTION_ENABLED) {
        this.logger.log(`🛎️ [话筒交还] 识别到员工 @机器人 发言，触发显式交还话筒: convId=${convId}`);
        await this.handleStaffMessage(convId, msg);
        return { status: 'STAFF_HANDLED', messageId, conversationId: convId };
      }

      // 否则为员工向机器人发起提问/指令：重置话筒归 BOT，并继续入缓冲池由智能体回答！
      this.logger.log(
        `🤖 内部员工 @机器人 提问，话筒切回 BOT 并入缓冲池处理: convId=${convId}, staffId=${msg.sender.channelUserId}`,
      );
      if (this.microphoneService) {
        await this.microphoneService.returnByMention(convId, msg.sender.channelUserId);
      }
      await this.timerService?.cancelHumanWait?.(convId, 0);
    }

    // ④ 外部客户消息（CUSTOMER）或员工提问：检查话筒状态分流
    const senderId = msg.sender.channelUserId;
    const micStatus = this.microphoneService
      ? await this.microphoneService.getMicStatus(convId)
      : { owner: 'BOT' as const, isHandoffLocked: false, epoch: 1 };

    if (micStatus.owner === 'HUMAN') {
      // 话筒在人工手中：客户消息照常进入缓冲池累积，但不触发 3s 静默自动封组回答
      const meta = await this.bufferService.push(convId, senderId, messageId, msg.sentAt);
      this.logger.log(
        `📥 [话筒=HUMAN] 客户消息入缓冲池待人工处理: convId=${convId}, sender=${senderId}, count=${meta.count}`,
      );

      // 若未被主动转人工锁定，预约 60s 人工超时接回检查任务 (PRD §6.2、Task 3.5、S9 用例)
      // 客户连发追加发言防重置：仅首条未回复消息 (meta.isFirst !== false) 进行调度
      if (!micStatus.isHandoffLocked && meta.isFirst !== false) {
        await this.timerService?.scheduleHumanWait?.(convId, senderId, micStatus.epoch);
      }

      return {
        status: 'PROCESSED',
        messageId,
        conversationId: convId,
        sealedDirectly: false,
      };
    }

    // 话筒在 BOT 手中：正常走缓冲池排队与双计时器调度
    const meta = await this.bufferService.push(convId, senderId, messageId, msg.sentAt);

    this.logger.log(
      `📥 消息入缓冲池 [convId=${convId}, sender=${senderId}, count=${meta.count}, version=${meta.version}, isFirst=${meta.isFirst}]`,
    );

    // 会话首条客户消息：预约占位应答（每个会话只发一次，Q10）
    if (role === 'CUSTOMER') {
      await this.placeholderService
        ?.onCustomerMessage(msg.tenantId, convId, senderId)
        .catch((err: Error) => this.logger.warn(`预约占位应答失败: ${err.message}`));
    }

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
   * 判定客服发言是否为专属交接/退法语境话术
   */
  private isStaffHandoverPhrase(text?: string | null): boolean {
    if (!text) return false;
    return (
      text.includes('交给你继续服务') ||
      text.includes('已沟通完毕') ||
      text.includes('接管下') ||
      text.includes('辛苦你继续') ||
      text.includes('我退出了')
    );
  }

  /**
   * 处理人工客服发言（话筒抢夺、在途组作废、缓冲归档、@机器人交还）
   */
  private async handleStaffMessage(convId: number, msg: InboundMessage): Promise<void> {
    const role = msg.sender.role;
    const staffId = msg.sender.channelUserId;

    // 1. 检查是否为客服 @机器人 显式交还话筒 (PRD §6.2、Task 3.7、附录 C S10)
    const botId = this.env.WECOM_BOT_ID;
    const hasMentionBot =
      msg.mentions?.some(
        (m) =>
          m === 'BOT' ||
          m.toLowerCase().includes('bot') ||
          (botId && m === botId) ||
          m === 'ai_assistant',
      ) ||
      Boolean(msg.text && (msg.text.includes('@机器人') || msg.text.includes('@小助理')));

    if (this.env.MIC_RETURN_BY_MENTION_ENABLED && hasMentionBot && this.microphoneService) {
      this.logger.log(`🛎️ [话筒交还] 识别到客服 @机器人 发言，触发显式交还话筒: convId=${convId}, staffId=${staffId}`);
      const returnRes = await this.microphoneService.returnByMention(convId, staffId);
      await this.timerService?.cancelHumanWait?.(convId, returnRes.epoch);

      // 附录 C 用例 S10: 话筒→BOT，发送专属交还占位语
      const welcomeText = '尊敬的客户，您好，我是您的专属客服，接下来由我持续为您服务！';
      if (this.channelAdapter) {
        try {
          await this.channelAdapter.send({
            tenantId: msg.tenantId,
            channel: msg.channel,
            channelChatId: msg.channelChatId,
            kind: 'PLACEHOLDER',
            text: welcomeText,
            conversationId: convId,
          });
          this.logger.log(`📨 [话筒交还] 已向会话 [convId=${convId}] 渠道群聊下发专属交还欢迎语`);
        } catch (sendErr) {
          this.logger.warn(`⚠️ [话筒交还] 下发专属交还欢迎语失败: ${(sendErr as Error).message}`);
        }
      }
      return;
    }

    // 2. 检查抢占范围参数 (PRD §11.3、Task 3.2、S21 用例)
    if (this.env.MIC_SEIZE_SCOPE === 'CS_ONLY' && role === 'STAFF_OTHER') {
      this.logger.log(
        `👔 内部其他员工发言 (STAFF_OTHER)，但 MIC_SEIZE_SCOPE=CS_ONLY，跳过话筒抢夺: convId=${convId}`,
      );
      return;
    }

    // 3. 驱动原子抢话筒 (Task 3.1 & 3.2)
    const redis = this.redisService.getClient();
    let currentEpoch = 1;
    if (this.microphoneService) {
      const seizeRes = await this.microphoneService.seizeByStaff(convId, staffId, role);
      currentEpoch = seizeRes.epoch;
    } else {
      const pool = this.mysqlService.getPool();
      await pool.query(`UPDATE conversation SET mic_owner = 'HUMAN' WHERE id = ?`, [convId]);
      await redis?.hset?.(REDIS_KEYS.mic(convId), {
        owner: 'HUMAN',
        staffId,
        seizedAt: String(Date.now()),
      });
    }

    // 4. 取消 60s 人工未回复等待任务 (Task 3.5)
    await this.timerService?.cancelHumanWait?.(convId, currentEpoch);

    const pool = this.mysqlService.getPool();

    // 5. 在途组作废检查与联动 (Task 1.2 / Task 3.3 / S7 用例)
    const inflightKey = REDIS_KEYS.inflight(convId);
    const inflight = await redis?.hgetall?.(inflightKey);
    if (inflight && inflight.groupId) {
      try {
        const [rows] = await pool.query<RowDataPacket[]>(
          'SELECT status, turn_id FROM msg_group WHERE id = ?',
          [inflight.groupId],
        );
        const currentStatus = rows?.[0]?.status;
        const groupTurnId = rows?.[0]?.turn_id;
        const effectiveTurnId = groupTurnId || inflight.turnId;

        if (
          (currentStatus === 'UNDERSTANDING' || currentStatus === 'FINAL_CHECKING') &&
          this.stateTransitionService
        ) {
          // 5.1 原子跃迁 msg_group 状态为 VOIDED
          await this.stateTransitionService.transition(
            'GROUP',
            inflight.groupId,
            currentStatus,
            'VOIDED',
            {
              tenantId: msg.tenantId,
              operatorType: 'STAFF',
              reason: 'MIC_SEIZED',
              traceId: String(msg.channelMsgId),
            },
          );

          // 5.2 同步更新关联轮次 turn 表记录 (reply_status='VOIDED', status='DONE')
          if (effectiveTurnId) {
            await pool.query(
              `UPDATE turn SET reply_status = 'VOIDED', status = 'DONE', finished_at = NOW(3) WHERE id = ?`,
              [effectiveTurnId],
            );
          }

          // 5.3 触发在途 LLM 生成任务中断（尽力而为节省 Token）
          this.abortInflight(inflight.groupId);

          this.logger.log(
            `🚨 [S7] 员工发言抢占话筒，在途组 #${inflight.groupId} (${currentStatus}) 已原子作废为 VOIDED, 轮次 #${effectiveTurnId || 'N/A'} 已标记作废`,
          );
        }
      } catch (err: any) {
        this.logger.warn(`在途组作废流转失败: ${err.message}`);
      }
      await redis?.del?.(inflightKey);
      await redis?.del?.(REDIS_KEYS.convLock(convId));
    }

    // 6. 客户未处理缓冲池消息就地封组归档 (Task 1.3 / Task 3.4 / S8 用例)
    const senders = (await this.bufferService?.nonEmptySenders?.(convId)) || [];
    for (const sender of senders) {
      const messageIds = await this.bufferService.drain(convId, sender);
      if (messageIds && messageIds.length > 0) {
        const [msgRows] = await pool.query<RowDataPacket[]>(
          'SELECT content, sent_at FROM message WHERE id IN (?) ORDER BY sent_at ASC',
          [messageIds],
        );
        const mergedText = (Array.isArray(msgRows) ? msgRows : [])
          .map((r: any) => r.content || '')
          .filter(Boolean)
          .join('\n');
        const firstMsgAt = (Array.isArray(msgRows) && msgRows[0]?.sent_at) || new Date();

        const [groupRes] = await pool.query<any>(
          `INSERT INTO msg_group (
             tenant_id, conversation_id, sender_channel_user_id,
             status, seal_reason, message_count, merged_text,
             first_msg_at, sealed_at
           ) VALUES (?, ?, ?, 'ARCHIVED', 'HUMAN_REPLIED', ?, ?, ?, NOW(3))`,
          [msg.tenantId, convId, sender, messageIds.length, mergedText, firstMsgAt],
        );
        const groupId = groupRes.insertId;

        await pool.query(
          `UPDATE message SET group_id = ? WHERE id IN (?)`,
          [groupId, messageIds],
        );

        // 获取当前轮次序号与规则包版本
        const [convRows] = await pool.query<RowDataPacket[]>(
          'SELECT turn_count, rule_pack_version FROM conversation WHERE id = ?',
          [convId],
        );
        const nextSeq =
          Array.isArray(convRows) && convRows[0]?.turn_count != null
            ? convRows[0].turn_count + 1
            : 1;
        const rulePackVersion =
          (Array.isArray(convRows) && convRows[0]?.rule_pack_version) || 'v1.0.0';

        const [turnRes] = await pool.query<any>(
          `INSERT INTO turn (
             tenant_id, conversation_id, seq,
             status, responder, reply_text, reply_status, rule_pack_version,
             started_at, finished_at
           ) VALUES (?, ?, ?, 'DONE', 'HUMAN', ?, 'SENT', ?, ?, NOW(3))`,
          [msg.tenantId, convId, nextSeq, msg.text || '', rulePackVersion, firstMsgAt],
        );
        const turnId = turnRes.insertId;

        // 关联更新 msg_group 的 turn_id
        await pool.query('UPDATE msg_group SET turn_id = ? WHERE id = ?', [turnId, groupId]);

        await pool.query(
          `UPDATE conversation SET turn_count = turn_count + 1 WHERE id = ?`,
          [convId],
        );

        // 异步更新/追加至会话笔记 conversation_background（记录人工问答历史，确保后续接管上下文延续）
        try {
          await pool.query(
            `INSERT INTO conversation_background (conversation_id, tenant_id, content, updated_turn_seq, updated_at)
             VALUES (?, ?, JSON_ARRAY(JSON_OBJECT('turnSeq', ?, 'question', ?, 'reply', ?, 'staffId', ?, 'time', NOW(3))), ?, NOW(3))
             ON DUPLICATE KEY UPDATE
               content = JSON_ARRAY_APPEND(content, '$', JSON_OBJECT('turnSeq', VALUES(updated_turn_seq), 'question', ?, 'reply', ?, 'staffId', ?, 'time', NOW(3))),
               updated_turn_seq = VALUES(updated_turn_seq),
               updated_at = NOW(3)`,
            [
              convId,
              msg.tenantId,
              nextSeq,
              mergedText,
              msg.text || '',
              msg.sender.channelUserId,
              nextSeq,
              mergedText,
              msg.text || '',
              msg.sender.channelUserId,
            ],
          );
        } catch (noteErr: any) {
          this.logger.warn(`会话笔记更新失败: ${noteErr.message}`);
        }

        this.logger.log(
          `📦 [S8] 员工抢跑解答，客户未处理缓冲消息 [${messageIds.length}条] 就地封组归档 (ARCHIVED), 形成人工轮次 #${nextSeq}`,
        );
      }
    }
  }
}
