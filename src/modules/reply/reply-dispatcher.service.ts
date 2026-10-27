import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { ENV, type Env } from '../../config/env';
import { MysqlService } from '../../database/mysql.service';
import { QueueService } from '../../infra/queue/queue.service';
import { CHANNEL_ADAPTER, type ChannelAdapter, type MessageRef, type TurnContext } from '../../contracts';
import { FinalCheckService } from '../pipeline/final-check.service';
import { MicrophoneService } from '../pipeline/microphone.service';
import { SealerService } from '../pipeline/sealer.service';
import { StateTransitionService } from '../pipeline/state-transition.service';
import { TimerService } from '../pipeline/timer.service';
import { REPLY_QUEUES, type PostJob, type TurnResult, type TurnResultJob } from './reply.contracts';

const CONCURRENCY = 50;

/** 本次处理的结论，便于测试断言 */
export interface DispatchOutcome {
  result: TurnResult | 'SKIPPED';
  replyMessageId?: number;
}

/**
 * 发送端（封组之后的后半段，倪开）：消费核心服务投递的回复（agent.queue.post），
 * 复用运行时的末检、话筒、计时器与封组器（不改其逻辑），发出后回报核心服务（agent.queue.turn-result）。
 *
 * 1. 组必须仍在 FINAL_CHECKING（看门狗兜底过的组不再发）；
 * 2. SILENT（机器人关闭）不发；
 * 3. 末检 FinalCheckService.finalCheck：话筒被抢 → VOIDED；客户纠正 → 并组、以 mergeCount + 1 重新投递 agent.queue.turn；
 * 4. FinalCheckService.safeSend 发出（发前最后一刻再验话筒）；
 * 5. 转人工：私信交接包给客服；lockMic 时锁话筒不自动交回，否则人工持话筒并预约 60 秒未回复接回；
 * 6. 写 BOT 消息、reply_msg_id、seal_to_send_ms；CLOSE 启动收尾空闲计时；
 * 7. 回报核心服务，再 onTurnDone 释放会话锁（重算时不释放，锁留给重算后的这一轮）。
 */
@Injectable()
export class ReplyDispatcherService implements OnModuleInit {
  private readonly logger = new Logger(ReplyDispatcherService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly queues: QueueService,
    private readonly mysql: MysqlService,
    private readonly finalCheck: FinalCheckService,
    private readonly mic: MicrophoneService,
    private readonly timers: TimerService,
    private readonly sealer: SealerService,
    private readonly states: StateTransitionService,
    @Inject(CHANNEL_ADAPTER) private readonly channel: ChannelAdapter,
  ) {}

  /**
   * 企微智能机器人只有一条长连接，只在持有它的实例上消费（多台应用机时其余实例设 WECOM_BOT_ENABLED=false）；
   * 测试环境打开测试注入时也消费（测试会话只记录不外发）。
   */
  onModuleInit(): void {
    // 机器人凭证可能只在配置中心的 wecom 命名空间里（环境变量没有 WECOM_BOT_ID），所以只按本机开关判断
    const hasBot = this.env.WECOM_BOT_ENABLED !== false;
    if (!hasBot && !this.env.TEST_INJECT_ENABLED) {
      this.logger.warn('本实例没有企微机器人长连接，也没开测试注入，不消费 agent.queue.post');
      return;
    }
    this.queues.createWorker<PostJob>(REPLY_QUEUES.post, (job: Job<PostJob>) => this.dispatch(job.data), { concurrency: CONCURRENCY });
  }

  async dispatch(post: PostJob): Promise<DispatchOutcome> {
    const tag = `[${post.traceId}] 组 #${post.groupId}`;
    const group = await this.loadGroup(post);
    if (!group) {
      this.logger.warn(`${tag} 不存在，丢弃回复`);
      return { result: 'SKIPPED' };
    }
    if (group.status !== 'FINAL_CHECKING') {
      // 看门狗已兜底或已处理过：不再发，也不释放会话锁（由处理方负责）
      this.logger.warn(`${tag} 当前状态 ${group.status}，回复作废`);
      await this.report(post, 'VOIDED');
      return { result: 'VOIDED' };
    }

    const ctx = this.contextOf(post, group);
    try {
      if (post.kind === 'SILENT' || !post.reply) {
        await this.finishSilent(post);
        return await this.done(post, 'SENT');
      }

      const verdict = await this.finalCheck.finalCheck(ctx);
      const action = String(verdict?.action ?? verdict);
      if (action === 'VOID') return await this.done(post, 'VOIDED');
      if (action === 'RECOMPUTE') {
        await this.report(post, 'RECOMPUTE');
        await this.requeue(post, ctx);
        return { result: 'RECOMPUTE' };
      }

      const sent = await this.finalCheck.safeSend(ctx, post.reply);
      if (!sent) return await this.done(post, 'VOIDED');

      const replyMessageId = await this.recordSent(post, ctx);
      await this.afterSend(post);
      return await this.done(post, 'SENT', replyMessageId);
    } catch (err) {
      this.logger.error(`${tag} 发送失败：${(err as Error).message}`, (err as Error).stack);
      await this.markFailed(post).catch((e: Error) => this.logger.error(`${tag} 记录发送失败出错：${e.message}`));
      return await this.done(post, 'SEND_FAILED');
    }
  }

  /** 回报核心服务并释放会话锁、拉起滞留消息 */
  private async done(post: PostJob, result: TurnResult, replyMessageId?: number): Promise<DispatchOutcome> {
    await this.report(post, result, replyMessageId);
    await this.sealer.onTurnDone(post.conversationId).catch((e: Error) => this.logger.error(`[${post.traceId}] onTurnDone 失败：${e.message}`));
    return { result, replyMessageId };
  }

  private async report(post: PostJob, result: TurnResult, replyMessageId?: number): Promise<void> {
    const data: TurnResultJob = { turnId: post.turnId, groupId: post.groupId, mergeCount: post.mergeCount, result, replyMessageId };
    await this.queues.getQueue<TurnResultJob>(REPLY_QUEUES.result).add('result', data, { removeOnComplete: 1000, removeOnFail: 5000 });
  }

  private async loadGroup(post: PostJob): Promise<{ status: string; merged_text: string } | undefined> {
    const [rows] = await this.mysql.getPool().query<RowDataPacket[]>(
      'SELECT status, merged_text FROM msg_group WHERE id = ? AND tenant_id = ?', [post.groupId, post.tenantId]);
    return rows[0] as { status: string; merged_text: string } | undefined;
  }

  /** 运行时末检要的上下文：末检只看本组发送人（senderId）在 sealedAt 之后的新消息 */
  private contextOf(post: PostJob, group: { merged_text: string }): TurnContext & { senderId: string } {
    return {
      traceId: post.traceId, tenantId: post.tenantId, conversationId: post.conversationId, turnId: post.turnId, groupId: post.groupId,
      isFirstTurn: false, groupText: group.merged_text, groupMessages: [], customer: {},
      background: { turns: [], profile: {}, emotionTrack: [], unresolved: [], counters: { correctionTotal: 0, correctionConsecutive: 0, lowConfConsecutive: 0, emotionBurst: 0 }, factCard: { answered: [], pending: [] } },
      rulePackVersion: '', sealedAt: post.sealedAt ?? undefined, mergeCount: post.mergeCount, timings: {},
      reply: post.reply ? { text: post.reply.text, confidence: post.confidence } : undefined,
      senderId: post.senderUserId,
    };
  }

  /** 机器人关闭：不发，组和轮正常结束 */
  private async finishSilent(post: PostJob): Promise<void> {
    await this.states.transition('GROUP', post.groupId, 'FINAL_CHECKING', 'SENT', { tenantId: post.tenantId, traceId: post.traceId, reason: 'BOT_SILENT' })
      .catch((e: Error) => this.logger.warn(`[${post.traceId}] 组 #${post.groupId} 结束失败：${e.message}`));
    await this.mysql.getPool().query(`UPDATE turn SET status = 'DONE', finished_at = NOW(3) WHERE id = ? AND tenant_id = ?`, [post.turnId, post.tenantId]);
  }

  /** 末检纠正：组已并入新消息、退回 UNDERSTANDING，按新组文本重新投递给核心服务（会话锁保持） */
  private async requeue(post: PostJob, ctx: TurnContext): Promise<void> {
    const rows = (sql: string, params: unknown[]) => this.mysql.getPool().query<RowDataPacket[]>(sql, params).then(([r]) => r);
    const [conv, turn, msgs] = await Promise.all([
      rows('SELECT customer_snapshot, rule_pack_version FROM conversation WHERE id = ? AND tenant_id = ?', [post.conversationId, post.tenantId]),
      rows('SELECT seq FROM turn WHERE id = ? AND tenant_id = ?', [post.turnId, post.tenantId]),
      rows('SELECT id, channel_msg_id, sender_role, content, sent_at FROM message WHERE group_id = ? AND tenant_id = ? ORDER BY sent_at, id', [post.groupId, post.tenantId]),
    ]);
    const snapshot = conv[0]?.customer_snapshot;
    const groupMessages: MessageRef[] = msgs.map((m) => ({
      messageId: Number(m.id), channelMsgId: m.channel_msg_id, senderRole: m.sender_role, text: m.content ?? '', sentAt: new Date(m.sent_at).getTime(),
    }));
    const mergeCount = ctx.mergeCount ?? post.mergeCount + 1;
    const context: TurnContext = {
      ...ctx,
      isFirstTurn: Number(turn[0]?.seq ?? 0) === 1,
      groupMessages,
      customer: (typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot) ?? {},
      rulePackVersion: conv[0]?.rule_pack_version ?? '',
      mergeCount,
      reply: undefined,
      finalCheck: undefined,
    };
    delete (context as { senderId?: string }).senderId;
    await this.queues.getQueue(REPLY_QUEUES.turn).add('run', { groupId: post.groupId, turnId: post.turnId, context }, { jobId: `turn:${post.groupId}:${mergeCount}` });
    this.logger.log(`[${post.traceId}] 组 #${post.groupId} 末检纠正，已重新投递理解（第 ${mergeCount} 次合并）`);
  }

  /** 发出后：写 BOT 消息、轮的发送字段（运行时 safeSend 已写 reply_status / reply_text、组 SENT） */
  private async recordSent(post: PostJob, ctx: TurnContext): Promise<number> {
    const reply = post.reply!;
    const pool = this.mysql.getPool();
    const [ins] = await pool.query<ResultSetHeader>(
      `INSERT INTO message (tenant_id, conversation_id, group_id, channel, channel_msg_id, sender_role, sender_channel_user_id, msg_type, content, mentions, sent_at, received_at)
       VALUES (?, ?, ?, ?, ?, 'BOT', 'bot', 'text', ?, ?, NOW(3), NOW(3))
       ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
      [post.tenantId, post.conversationId, post.groupId, reply.channel, `bot:${post.turnId}:${post.mergeCount}`, reply.text, JSON.stringify(reply.mentions ?? [])],
    );
    const fc = ctx.finalCheck;
    await pool.query(
      `UPDATE turn SET reply_status = ?, reply_msg_id = ?, seal_to_send_ms = ?, merge_count = ?, final_check_relation = ?, final_check_msg_ids = ? WHERE id = ? AND tenant_id = ?`,
      [
        post.degraded ? 'DEGRADED' : 'SENT', ins.insertId, post.sealedAt ? Date.now() - post.sealedAt : null, post.mergeCount,
        fc && fc.messages.length ? fc.verdict : null, fc && fc.messages.length ? JSON.stringify(fc.messages.map((m) => m.messageId)) : null,
        post.turnId, post.tenantId,
      ],
    );
    return ins.insertId;
  }

  /** 转人工：私信交接包、话筒交给人工；收尾话术：启动收尾空闲计时 */
  private async afterSend(post: PostJob): Promise<void> {
    const h = post.handoff;
    if (h) {
      if (h.privateMessage) {
        await this.channel.send(h.privateMessage).catch((e: Error) => this.logger.error(`[${post.traceId}] 交接包私信失败：${e.message}`));
      }
      const staffId = h.staff?.wecomUserId ?? '';
      if (h.lockMic) {
        const locked = await this.mic.lockHandoff(post.conversationId, staffId, `AI_HANDOFF_${h.trigger}`);
        // 锁定型转人工同样等人工 HUMAN_WAIT_TIMEOUT_MS（默认 60s），期间人工没发言则强制交还机器人
        await this.timers.scheduleHumanWait(post.conversationId, post.senderUserId, locked.epoch, undefined, true);
      } else {
        const seized = await this.mic.seizeByStaff(post.conversationId, staffId, 'STAFF_CS', `AI_HANDOFF_${h.trigger}`);
        await this.timers.scheduleHumanWait(post.conversationId, post.senderUserId, seized.epoch);
      }
    }
    if (post.kind === 'CLOSE') await this.timers.scheduleIdle(post.conversationId, 'CLOSE');
  }

  private async markFailed(post: PostJob): Promise<void> {
    await this.mysql.getPool().query(
      `UPDATE turn SET status = 'DONE', reply_status = 'SEND_FAILED', finished_at = NOW(3) WHERE id = ? AND tenant_id = ?`, [post.turnId, post.tenantId]);
    await this.states.transition('GROUP', post.groupId, 'FINAL_CHECKING', 'VOIDED', { tenantId: post.tenantId, traceId: post.traceId, reason: 'SEND_FAILED' })
      .catch(() => undefined);
  }
}
