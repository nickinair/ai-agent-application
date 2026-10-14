/**
 * @file test-inject-suite.ts
 * @description Task 5.1: 智能体全能平台测试注入套件基建 (TestInjectSuite)
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §5.3、§13.1、§13.2
 */

import { InboundPipelineService, type InboundProcessResult } from '../../src/modules/pipeline/inbound-pipeline.service';
import { MysqlService } from '../../src/database/mysql.service';
import { RedisService } from '../../src/infra/redis/redis.service';
import { MicrophoneService } from '../../src/modules/pipeline/microphone.service';
import { BufferService } from '../../src/modules/pipeline/buffer.service';
import type { InboundMessage, MemberRole } from '../../src/contracts';
import { randomUUID } from 'node:crypto';

export interface InjectMessageOptions {
  chatId: string;
  senderId: string;
  role?: MemberRole;
  text: string;
  chatName?: string;
  senderName?: string;
  mentions?: string[];
  delayMs?: number;
  tenantId?: number;
  channelMsgId?: string;
  sentAt?: number;
}

export interface TurnTrace {
  turnId: number;
  conversationId: number;
  groupId: number;
  status: string;
  replyStatus: string;
  replyText?: string;
  voidReason?: string;
  finishedAt?: Date | string;
  timings?: Record<string, any>;
}

export interface ConversationStateSnapshot {
  conversationId: number;
  channelChatId: string;
  status: string;
  micOwner: 'BOT' | 'HUMAN';
  micStaffId?: string | null;
  micEpoch: number;
  bufferedMessageCount: number;
}

/**
 * 测试注入套件客户端 (TestInjectSuite)
 * 为阶段五全部用例（S1～S9, S17～S23, S25）提供自动化时序消息注入与状态追踪捕获能力
 */
export class TestInjectSuite {
  constructor(
    private readonly inboundService: InboundPipelineService,
    private readonly mysqlService?: MysqlService,
    private readonly redisService?: RedisService,
    private readonly micService?: MicrophoneService,
    private readonly bufferService?: BufferService,
  ) {}

  /**
   * 辅助睡眠毫秒
   */
  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 格式化构造统一入站消息
   */
  buildInboundMessage(options: InjectMessageOptions): InboundMessage {
    const role: MemberRole = options.role || 'CUSTOMER';
    const channelMsgId = options.channelMsgId || `test-${randomUUID()}`;
    const sentAt = options.sentAt || Date.now();

    return {
      tenantId: options.tenantId ?? 1,
      channel: 'test',
      channelChatId: options.chatId,
      channelMsgId,
      chatName: options.chatName || `测试群-${options.chatId}`,
      sender: {
        role,
        channelUserId: options.senderId,
        name: options.senderName || `用户-${options.senderId}`,
      },
      mentions: options.mentions || [],
      type: 'text',
      text: options.text,
      sentAt,
    };
  }

  /**
   * 注入单条带角色的测试消息
   * @param options 注入参数（支持可选 delayMs 先休眠后注入）
   */
  async injectMessage(options: InjectMessageOptions): Promise<InboundProcessResult> {
    if (options.delayMs && options.delayMs > 0) {
      await this.sleep(options.delayMs);
    }

    const inboundMsg = this.buildInboundMessage(options);
    return await this.inboundService.onInbound(inboundMsg);
  }

  /**
   * 顺序按时序注入多条消息序列
   * @param messages 消息参数列表，每条消息可携带各自的 delayMs 控制时间差
   */
  async injectSequence(messages: InjectMessageOptions[]): Promise<InboundProcessResult[]> {
    const results: InboundProcessResult[] = [];
    for (const msgOpt of messages) {
      const res = await this.injectMessage(msgOpt);
      results.push(res);
    }
    return results;
  }

  /**
   * 通用异步轮询条件等待器
   * @param predicate 判断逻辑
   * @param timeoutMs 超时时间，默认 5000ms
   * @param stepMs 轮询间隔，默认 30ms
   */
  async waitForCondition(
    predicate: () => Promise<boolean> | boolean,
    timeoutMs = 5000,
    stepMs = 30,
  ): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const ok = await predicate();
      if (ok) return;
      await this.sleep(stepMs);
    }
    throw new Error(`[TestInjectSuite] 等待超时 (${timeoutMs}ms) 未满足期望条件`);
  }

  /**
   * 等待指定消息组封组完成
   * @param groupId 消息组 ID
   * @param timeoutMs 超时时间
   */
  async waitForGroupSeal(groupId: number, timeoutMs = 5000): Promise<any> {
    let groupRecord: any = null;

    await this.waitForCondition(async () => {
      if (!this.mysqlService) return true;
      const pool = this.mysqlService.getPool();
      const [rows] = await pool.query<any[]>(
        `SELECT id, conversation_id, status, message_count, text, sealed_at FROM msg_group WHERE id = ?`,
        [groupId],
      );
      if (rows && rows.length > 0 && rows[0].status !== 'BUFFERING') {
        groupRecord = rows[0];
        return true;
      }
      return false;
    }, timeoutMs);

    return groupRecord;
  }

  /**
   * 等待指定问答轮次结束 (status = DONE)
   * @param turnId 轮次 ID
   * @param timeoutMs 超时时间
   */
  async waitForTurnCompletion(turnId: number, timeoutMs = 5000): Promise<TurnTrace> {
    let turnRecord: any = null;

    await this.waitForCondition(async () => {
      if (!this.mysqlService) return true;
      const pool = this.mysqlService.getPool();
      const [rows] = await pool.query<any[]>(
        `SELECT id, conversation_id, group_id, status, reply_status, reply_text, void_reason, finished_at FROM turn WHERE id = ?`,
        [turnId],
      );
      if (rows && rows.length > 0 && rows[0].status === 'DONE') {
        turnRecord = rows[0];
        return true;
      }
      return false;
    }, timeoutMs);

    return {
      turnId,
      conversationId: turnRecord?.conversation_id,
      groupId: turnRecord?.group_id,
      status: turnRecord?.status || 'DONE',
      replyStatus: turnRecord?.reply_status,
      replyText: turnRecord?.reply_text,
      voidReason: turnRecord?.void_reason,
      finishedAt: turnRecord?.finished_at,
    };
  }

  /**
   * 获取指定轮次的完整链路轨迹
   */
  async getTurnTrace(turnId: number): Promise<TurnTrace | null> {
    if (!this.mysqlService) return null;
    const pool = this.mysqlService.getPool();
    const [rows] = await pool.query<any[]>(
      `SELECT id, conversation_id, group_id, status, reply_status, reply_text, void_reason, finished_at FROM turn WHERE id = ?`,
      [turnId],
    );
    if (!rows || rows.length === 0) return null;
    const r = rows[0];
    return {
      turnId: r.id,
      conversationId: r.conversation_id,
      groupId: r.group_id,
      status: r.status,
      replyStatus: r.reply_status,
      replyText: r.reply_text,
      voidReason: r.void_reason,
      finishedAt: r.finished_at,
    };
  }

  /**
   * 获取当前会话状态快照（含状态、话筒所有权与缓冲池余留）
   */
  async getConversationState(convId: number): Promise<ConversationStateSnapshot | null> {
    let convRecord: any = null;
    if (this.mysqlService) {
      const pool = this.mysqlService.getPool();
      const [rows] = await pool.query<any[]>(
        `SELECT id, channel_chat_id, status FROM conversation WHERE id = ?`,
        [convId],
      );
      if (rows && rows.length > 0) convRecord = rows[0];
    }

    let micOwner: 'BOT' | 'HUMAN' = 'BOT';
    let micStaffId: string | null = null;
    let micEpoch = 1;

    if (this.micService) {
      const mic = await this.micService.getMicStatus(convId);
      micOwner = mic.owner;
      micStaffId = mic.staffId;
      micEpoch = mic.epoch;
    }

    let bufferedCount = 0;
    if (this.bufferService) {
      const msgs = await this.bufferService.peekSince(convId, 0);
      bufferedCount = msgs?.length || 0;
    }

    return {
      conversationId: convId,
      channelChatId: convRecord?.channel_chat_id || String(convId),
      status: convRecord?.status || 'ACTIVE',
      micOwner,
      micStaffId,
      micEpoch,
      bufferedMessageCount: bufferedCount,
    };
  }
}
