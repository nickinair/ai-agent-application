/**
 * @file final-check.service.ts
 * @description 发送前增量消息嗅探服务 FinalCheckService（第六关「发」第一道门禁）
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §5.8.1
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { BufferService } from './buffer.service';
import { StateTransitionService } from './state-transition.service';
import { MicrophoneService } from './microphone.service';
import { MysqlService } from '../../database/mysql.service';
import { MetricsService, type VoidReason } from '../../infra/metrics.service';
import {
  CHANNEL_ADAPTER,
  type ChannelAdapter,
  type OutboundMessage,
  type TurnContext,
  type MessageRef,
  type TurnRelation,
} from '../../contracts';

export type FinalCheckInspectResult = 'SEND' | MessageRef[];

/**
 * 纠正/否定意图规则匹配正则字典
 * 覆盖：不对、搞错、说错、问的是、我说的是、不是这个、不是这样、理解错、错啦、别答这个、你搞错|你理解错|(?:^|[，,。\s!！])不是(?:[，,。\s!！]|我|要|指|说))/i;
 */
export const CORRECTION_REGEX =
  /(?:不对|搞错|说错|问的是|我说的是|不是这个|不是这样|理解错|错啦|别答这个|你搞错|你理解错|(?:^|[，,。\s!！])不是(?:[，,。\s!！]|我|要|指|说))/i;

/**
 * 换题意图规则匹配正则字典（附录 C 用例 S6）
 * 覆盖：另外、顺便、还有、换个问题、换个话题、再问下、再问一个、其他问题、咨询下别的事、还有个事、对了...
 */
export const NEW_TOPIC_REGEX =
  /(?:另外|顺便|还有|换个问题|换个话题|再问下|再问一个|其他问题|咨询下别的事|还有个事|问下别的|咨询下别的|(?:^|[，,。\s!！])对了(?:[，,。\s!！]|我|问))/i;

@Injectable()
export class FinalCheckService {
  private readonly logger = new Logger(FinalCheckService.name);

  constructor(
    private readonly bufferService: BufferService,
    @Optional() private readonly stateTransitionService?: StateTransitionService,
    @Optional() private readonly microphoneService?: MicrophoneService,
    @Optional() @Inject(CHANNEL_ADAPTER) private readonly channelAdapter?: ChannelAdapter,
    @Optional() private readonly mysqlService?: MysqlService,
    @Optional() private readonly metricsService?: MetricsService,
  ) {}

  /**
   * 嗅探封组后是否有新进增量消息（非破坏性不出队，≤ 1ms 快速短路返回）
   * @param ctx 当前轮次上下文 TurnContext 或参数对象
   * @returns 若无新消息返回 'SEND'；若有新消息返回增量消息数组 MessageRef[]（支持 status / messages 属性扩展）
   */
  async inspect(
    ctx: TurnContext | { conversationId: number | string; sealedAt?: number | Date; senderId?: string },
  ): Promise<any> {
    const startTime = Date.now();
    const convId = ctx.conversationId;
    const sealedAt =
      (ctx as TurnContext).sealedAt ||
      (ctx as TurnContext).timings?.sealedAt ||
      (ctx as any).sealedAt ||
      0;
    const senderId = (ctx as any).senderId;

    const newMsgs = await this.bufferService.peekSince(convId, sealedAt, senderId);

    if (!newMsgs || newMsgs.length === 0) {
      const elapsed = Date.now() - startTime;
      this.logger.debug(
        `⚡ [FinalCheck] 会话 #${convId} 末检无增量消息，快速短路放行 (耗时=${elapsed}ms)`,
      );
      // 返回兼容对象：既可当作字符串 'SEND'，也支持 .status === 'SEND' 与 .messages === []
      return Object.assign(new String('SEND'), {
        status: 'SEND' as const,
        action: 'SEND' as const,
        messages: [] as MessageRef[],
      });
    }

    this.logger.log(
      `🔍 [FinalCheck] 会话 #${convId} 嗅探到 ${newMsgs.length} 条增量消息 (sealedAt=${sealedAt})`,
    );

    // 返回兼容对象：本身即为 MessageRef[] 数组，同时挂载 .status 与 .messages 属性
    return Object.assign(newMsgs, {
      status: 'NEW_MESSAGES' as const,
      action: 'NEW_MESSAGES' as const,
      messages: newMsgs,
    });
  }

  /**
   * 接关规则词典比对：判定新消息与既有文本的关系
   * @param oldText 原组内文本或上轮文本
   * @param newText 新增量消息文本
   * @returns 接关关系类型（'CORRECT' | 'NEW_TOPIC' | 'CONTINUE'）
   */
  matchRelation(oldText: string, newText: string): TurnRelation {
    if (!newText) return 'CONTINUE';
    const trimmed = newText.trim();
    if (CORRECTION_REGEX.test(trimmed)) {
      return 'CORRECT';
    }
    if (NEW_TOPIC_REGEX.test(trimmed)) {
      return 'NEW_TOPIC';
    }
    return 'CONTINUE';
  }

  /**
   * 发送末检完整决策关卡（第六关「发」）：
   * 0. 话筒所有权核验：若已被人工抢夺，强制置为 VOID 并拦截；
   * 1. 嗅探是否有新进增量消息；
   * 2. 若无新消息，短路返回 'SEND'；
   * 3. 若有新消息，通过接关规则词典判定是否为客户纠正 (CORRECT)；
   * 4. S4 用例：首次纠正且 mergeCount < 1，出队并入组并重算，组状态迁回 UNDERSTANDING，返回 'RECOMPUTE'；
   * 5. S5 用例：重算达到上限 (mergeCount >= 1)，不再合并，返回 'SEND'，新消息留存缓冲池供下一组处理；
   * 6. 其他非纠正消息（NEW_TOPIC / CONTINUE），返回 'SEND'，新消息留存缓冲池。
   */
  async finalCheck(ctx: TurnContext): Promise<any> {
    // 0. 话筒所有权第一道核验：若已被坐席抢走，强制直接作废 (VOIDED)
    if (this.microphoneService) {
      const mic = await this.microphoneService.getMicStatus(ctx.conversationId);
      if (mic.owner === 'HUMAN') {
        this.logger.warn(
          `🚨 [FinalCheck] 话筒已被坐席抢占 (staffId=${mic.staffId})，当前组与回复直接作废 (VOIDED)`,
        );
        await this.recordVoided(ctx, 'MIC_SEIZED');

        return Object.assign(new String('VOID'), {
          action: 'VOID' as const,
          status: 'VOID' as const,
          verdict: 'VOID' as const,
          messages: [] as MessageRef[],
          recomputed: false,
        });
      }
    }

    const inspectRes = await this.inspect(ctx);

    // 1. 无新消息，直接放行
    if (
      inspectRes === 'SEND' ||
      inspectRes.status === 'SEND' ||
      !inspectRes.messages ||
      inspectRes.messages.length === 0
    ) {
      ctx.finalCheck = {
        verdict: 'PASS',
        messages: [],
        recomputed: false,
      };
      return Object.assign(new String('SEND'), {
        action: 'SEND' as const,
        status: 'SEND' as const,
        verdict: 'PASS' as const,
        messages: [] as MessageRef[],
        recomputed: false,
      });
    }

    // 2. 提取新消息文本并判定关系
    const newMsgs: MessageRef[] = Array.isArray(inspectRes)
      ? inspectRes
      : inspectRes.messages || [];
    const newText = newMsgs.map((m) => m.text).filter(Boolean).join('\n');
    const relation = this.matchRelation(ctx.groupText || '', newText);

    // 3. 关系判定分支
    if (relation === 'CORRECT') {
      const currentMergeCount = ctx.mergeCount || 0;

      // 3.1 S4 用例: 首次纠正且未达上限 (mergeCount < 1) -> 合并并重算
      if (currentMergeCount < 1) {
        this.logger.log(
          `🔄 [FinalCheck] 会话 #${ctx.conversationId} 组 #${ctx.groupId} 判定为纠正 (CORRECT)，执行合并重算 (mergeCount: ${currentMergeCount} -> 1)`,
        );

        // 如果重算前已有生成的草稿文本，属于废弃已生成内容，记录 RECOMPUTE_ABANDONED 埋点
        if (ctx.reply?.text && this.metricsService) {
          this.metricsService.recordTurnVoided('RECOMPUTE_ABANDONED', ctx.tenantId);
        }

        // 从缓冲池出队并并入组 (Redis LREM + DB update)
        const senderId = (ctx as any).senderId;
        await this.bufferService.takeInto(
          ctx.conversationId,
          ctx.groupId,
          newMsgs,
          senderId,
        );

        // 更新上下文
        ctx.groupText = ctx.groupText ? `${ctx.groupText}\n${newText}` : newText;
        ctx.groupMessages = [...(ctx.groupMessages || []), ...newMsgs];
        ctx.mergeCount = currentMergeCount + 1;
        ctx.sealedAt = Date.now();
        ctx.finalCheck = {
          verdict: 'CORRECT',
          messages: newMsgs,
          recomputed: true,
        };

        // 状态机跃迁组状态为 UNDERSTANDING
        if (this.stateTransitionService) {
          try {
            await this.stateTransitionService.transition(
              'GROUP',
              ctx.groupId,
              'FINAL_CHECKING',
              'UNDERSTANDING',
              {
                tenantId: ctx.tenantId,
                traceId: ctx.traceId,
                reason: '末检判定客户纠正(CORRECT)，合并新消息并退回理解重算',
              },
            );
          } catch (err: any) {
            this.logger.warn(
              `⚠️ [FinalCheck] 组 #${ctx.groupId} 状态退回 UNDERSTANDING 告警: ${err.message}`,
            );
          }
        }

        return Object.assign(new String('RECOMPUTE'), {
          action: 'RECOMPUTE' as const,
          status: 'RECOMPUTE' as const,
          verdict: 'CORRECT' as const,
          messages: newMsgs,
          recomputed: true,
        });
      }

      // 3.2 S5 用例: 已达上限 (mergeCount >= 1) -> 熔断，不再合并，按原回复照常发出
      this.logger.warn(
        `🛑 [FinalCheck] 会话 #${ctx.conversationId} 组 #${ctx.groupId} 重算已达上限 (mergeCount=${currentMergeCount})，熔断禁止再次合并，照常发出，新消息保留在缓冲池`,
      );
      ctx.finalCheck = {
        verdict: 'CORRECT',
        messages: newMsgs,
        recomputed: false,
      };

      return Object.assign(new String('SEND'), {
        action: 'SEND' as const,
        status: 'SEND' as const,
        verdict: 'CORRECT' as const,
        messages: newMsgs,
        recomputed: false,
      });
    }

    // 4. 非纠正消息（承接、追问或新话题）：照常发出当前回复，新消息完整保留在缓冲池供下一组处理
    this.logger.log(
      `➡️ [FinalCheck] 会话 #${ctx.conversationId} 组 #${ctx.groupId} 增量消息非纠正 (relation=${relation})，照常发出本轮，新消息留存缓冲池`,
    );
    ctx.finalCheck = {
      verdict: relation === 'NEW_TOPIC' ? 'NEW_TOPIC' : 'PASS',
      messages: newMsgs,
      recomputed: false,
    };

    return Object.assign(new String('SEND'), {
      action: 'SEND' as const,
      status: 'SEND' as const,
      verdict: relation === 'NEW_TOPIC' ? ('NEW_TOPIC' as const) : ('PASS' as const),
      messages: newMsgs,
      recomputed: false,
    });
  }

  /**
   * 渠道下发前最后一刻话筒终验防并发门禁（附录 C 用例 S7）
   * @param ctx 当前轮次上下文 TurnContext
   * @returns 话筒校验通过与否及原因
   */
  async preSendCheck(
    ctx: TurnContext,
  ): Promise<{ passed: boolean; verdict: 'PASS' | 'VOID'; reason?: string }> {
    if (!this.microphoneService) {
      return { passed: true, verdict: 'PASS' };
    }

    const mic = await this.microphoneService.getMicStatus(ctx.conversationId);
    if (mic.owner === 'HUMAN') {
      this.logger.warn(
        `🚨 [FinalCheck.preSendCheck] 渠道下发前最后一刻终验拦截: 话筒已被坐席抢占 (staffId=${mic.staffId}, epoch=${mic.epoch})`,
      );
      return { passed: false, verdict: 'VOID', reason: 'MIC_SEIZED' };
    }

    return { passed: true, verdict: 'PASS' };
  }

  /**
   * 记录“生成未发出”作废审计落库与指标埋点 (Task 4.5)
   * 1. 组状态机流转：msg_group 状态跃迁至 VOIDED
   * 2. 更新 turn 表：reply_status = 'VOIDED', void_reason = reason, status = 'DONE', reply_text = draftText, finished_at = NOW(3)
   * 3. 核心监控上报：Prometheus 指标 agent_turn_voided_total 递增
   * @param ctx 轮次上下文 TurnContext
   * @param reason 作废原因 ('MIC_SEIZED' | 'RECOMPUTE_ABANDONED' | 'RULE_BLOCKED' | string)
   * @param draftText 可选生成的草稿回复文本
   */
  async recordVoided(
    ctx: TurnContext,
    reason: VoidReason,
    draftText?: string,
  ): Promise<void> {
    ctx.finalCheck = {
      verdict: 'VOID',
      messages: [],
      recomputed: false,
    };

    const textToSave = draftText !== undefined ? draftText : ctx.reply?.text || '';

    // 1. 组状态跃迁为 VOIDED
    if (this.stateTransitionService) {
      try {
        await this.stateTransitionService.transition(
          'GROUP',
          ctx.groupId,
          'FINAL_CHECKING',
          'VOIDED',
          {
            tenantId: ctx.tenantId,
            traceId: ctx.traceId,
            reason,
          },
        );
      } catch (err: any) {
        this.logger.warn(
          `⚠️ [FinalCheck.recordVoided] 组 #${ctx.groupId} 跃迁 VOIDED 告警: ${err.message}`,
        );
      }
    }

    // 2. 轮次 turn 标记作废并记录 void_reason 与 reply_text
    if (this.mysqlService) {
      try {
        const pool = this.mysqlService.getPool();
        await pool.query(
          `UPDATE turn SET reply_status = 'VOIDED', void_reason = ?, reply_text = COALESCE(?, reply_text, ''), status = 'DONE', finished_at = NOW(3) WHERE id = ?`,
          [reason, textToSave, ctx.turnId],
        );
      } catch (err: any) {
        this.logger.error(
          `❌ [FinalCheck.recordVoided] 更新 turn #${ctx.turnId} 作废审计状态失败: ${err.message}`,
        );
      }
    }

    // 3. Prometheus 埋点上报
    if (this.metricsService) {
      this.metricsService.recordTurnVoided(reason, ctx.tenantId);
    }

    this.logger.warn(
      `🛑 [FinalCheck.recordVoided] 会话 #${ctx.conversationId} 组 #${ctx.groupId} 轮次 #${ctx.turnId} 已全量审计作废 (原因: ${reason}, 草稿字数: ${textToSave.length})`,
    );
  }

  /**
   * 安全网络下发（带最后一刻话筒核验 + 拦截阻断 + 数据库状态同步）
   * @param ctx 当前轮次上下文 TurnContext
   * @param outboundPayload 可选自定义出站消息内容
   * @returns true: 下发成功; false: 话筒被抢被拦截废弃
   */
  async safeSend(
    ctx: TurnContext,
    outboundPayload?: Partial<OutboundMessage>,
  ): Promise<boolean> {
    // 1. 毫秒级前置终验
    const check = await this.preSendCheck(ctx);
    if (!check.passed) {
      this.logger.warn(
        `🛑 [FinalCheck.safeSend] 会话 #${ctx.conversationId} 触发话筒终验拦截，掐断网络下发 (原因=${check.reason})`,
      );

      const reason: VoidReason = (check.reason as VoidReason) || 'MIC_SEIZED';
      await this.recordVoided(ctx, reason, outboundPayload?.text);

      return false;
    }

    // 2. 话筒完好，安全执行网络下发
    const replyText = outboundPayload?.text || ctx.reply?.text || '';
    if (this.channelAdapter) {
      const msg: OutboundMessage = {
        tenantId: ctx.tenantId || 1,
        channel: outboundPayload?.channel || 'wecom_group',
        channelChatId: outboundPayload?.channelChatId || String(ctx.conversationId),
        kind: outboundPayload?.kind || 'REPLY',
        text: replyText,
        conversationId: ctx.conversationId,
        mentions: outboundPayload?.mentions,
        toUserId: outboundPayload?.toUserId,
      };
      await this.channelAdapter.send(msg);
    }

    // 3. 标记组状态为 SENT 并更新 turn 表 reply_status = 'SENT'
    if (this.mysqlService) {
      const pool = this.mysqlService.getPool();
      await pool.query(
        `UPDATE turn SET reply_status = 'SENT', status = 'DONE', reply_text = ?, finished_at = NOW(3) WHERE id = ?`,
        [replyText, ctx.turnId],
      );
    }

    if (this.stateTransitionService) {
      try {
        await this.stateTransitionService.transition(
          'GROUP',
          ctx.groupId,
          'FINAL_CHECKING',
          'SENT',
          {
            tenantId: ctx.tenantId,
            traceId: ctx.traceId,
            reason: 'NORMAL_SEND',
          },
        );
      } catch (err: any) {
        // 静默处理并发时已流转的情况
      }
    }

    this.logger.log(`✅ [FinalCheck.safeSend] 会话 #${ctx.conversationId} 回复已成功安全下发`);
    return true;
  }
}


