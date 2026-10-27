/**
 * @file timer.service.ts
 * @description 静默、熔断与会话空闲超时多计时器调度服务（基于 BullMQ 延时任务与版本号匹配机制）
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §7.2、§7.3、S14 用例
 */

import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { RowDataPacket } from 'mysql2/promise';
import { ENV, type Env } from '../../config/env';
import { QueueService, QUEUE_NAMES } from '../../infra/queue/queue.service';
import { RedisService } from '../../infra/redis/redis.service';
import { REDIS_KEYS } from '../../infra/redis/redis.keys';
import { MysqlService } from '../../database/mysql.service';
import { BufferService } from './buffer.service';
import { StateTransitionService } from './state-transition.service';
import { MicrophoneService } from './microphone.service';

export type SealReason = 'QUIET' | 'HARD' | 'COUNT' | 'HUMAN_TIMEOUT';

export interface ISealer {
  seal(convId: number | string, senderId: string, reason: SealReason): Promise<any>;
}

export interface QuietJobData {
  type: 'quiet';
  convId: number | string;
  senderId: string;
  version: number;
}

export interface HardJobData {
  type: 'hard';
  convId: number | string;
  senderId: string;
  epoch: number;
}

export interface IdleJobData {
  type: 'idle';
  convId: number | string;
  seq: number;
  kind: 'NORMAL' | 'CLOSE';
}

export interface HumanWaitJobData {
  type: 'hwait';
  convId: number | string;
  senderId: string;
  micEpoch: number;
  /** AI 主动转人工（话筒锁定）后的等待：到点人工仍未发言则强制解锁交还机器人 */
  force?: boolean;
}

export type TimerJobData = QuietJobData | HardJobData | IdleJobData | HumanWaitJobData;

@Injectable()
export class TimerService implements OnModuleInit {
  private readonly logger = new Logger(TimerService.name);
  private sealer: ISealer | null = null;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly queueService: QueueService,
    private readonly bufferService: BufferService,
    @Optional() private readonly redisService?: RedisService,
    @Optional() private readonly mysqlService?: MysqlService,
    @Optional() private readonly stateTransitionService?: StateTransitionService,
    @Optional() private readonly microphoneService?: MicrophoneService,
  ) {}

  /**
   * 注册封组器执行实现
   */
  setSealer(sealer: ISealer): void {
    this.sealer = sealer;
  }

  onModuleInit(): void {
    // 启动 BullMQ Timer Worker 监听计时器任务
    this.queueService.createWorker<TimerJobData>(
      QUEUE_NAMES.timer,
      async (job: Job<TimerJobData>) => {
        await this.handleTimerJob(job);
      },
      { concurrency: 10 },
    );
  }

  /**
   * 调度 3s 静默延迟封组任务（版本号机制）
   * @param convId 会话 ID
   * @param senderId 发送人在渠道内的用户 ID
   * @param version 触发该计时器的消息版本号
   * @param delayMs 延时毫秒数，默认读取环境变量 QUIET_WINDOW_MS (3000ms)
   */
  async scheduleQuiet(
    convId: number | string,
    senderId: string,
    version: number,
    delayMs?: number,
  ): Promise<void> {
    const delay = delayMs ?? this.env.QUIET_WINDOW_MS;
    const queue = this.queueService.getQueue<QuietJobData>(QUEUE_NAMES.timer);
    // BullMQ 6 的自定义 jobId 含冒号时必须正好 3 段，发送人与版本号之间用 @
    const jobId = `quiet:${convId}:${senderId}@${version}`;

    await queue.add(
      'quiet',
      {
        type: 'quiet',
        convId,
        senderId,
        version,
      },
      {
        jobId,
        delay,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );

    this.logger.debug(
      `已预约静默封组检查 [jobId=${jobId}, delay=${delay}ms, version=${version}]`,
    );
  }

  /**
   * 调度 15s 熔断封组任务（epoch 代号机制）
   * @param convId 会话 ID
   * @param senderId 发送人在渠道内的用户 ID
   * @param epoch 当前缓冲池轮次代号
   * @param delayMs 延时毫秒数，默认读取环境变量 HARD_TIMEOUT_MS (15000ms)
   */
  async scheduleHard(
    convId: number | string,
    senderId: string,
    epoch: number,
    delayMs?: number,
  ): Promise<void> {
    const delay = delayMs ?? this.env.HARD_TIMEOUT_MS;
    const queue = this.queueService.getQueue<HardJobData>(QUEUE_NAMES.timer);
    const jobId = `hard:${convId}:${senderId}@${epoch}`;

    await queue.add(
      'hard',
      {
        type: 'hard',
        convId,
        senderId,
        epoch,
      },
      {
        jobId,
        delay,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );

    this.logger.debug(
      `已预约熔断封组检查 [jobId=${jobId}, delay=${delay}ms, epoch=${epoch}]`,
    );
  }

  /**
   * 调度会话空闲超时关闭任务（基于 Redis 版本号自增防竞态）
   * @param convId 会话 ID
   * @param kind 'NORMAL'（普通 30 分钟）或 'CLOSE'（完结收尾 5 分钟）
   * @param delayMs 可选定制延时，默认读取 SESSION_IDLE_TIMEOUT_MS / CLOSE_IDLE_TIMEOUT_MS
   */
  async scheduleIdle(
    convId: number | string,
    kind: 'NORMAL' | 'CLOSE' = 'NORMAL',
    delayMs?: number,
  ): Promise<number> {
    let seq = 1;
    if (this.redisService) {
      const redis = this.redisService.getClient();
      seq = await redis.incr(REDIS_KEYS.idleSeq(convId));
    }

    const defaultDelay =
      kind === 'CLOSE'
        ? (this.env.CLOSE_IDLE_TIMEOUT_MS ?? 5 * 60 * 1000)
        : (this.env.SESSION_IDLE_TIMEOUT_MS ?? 30 * 60 * 1000);
    const delay = delayMs ?? defaultDelay;

    const queue = this.queueService.getQueue<IdleJobData>(QUEUE_NAMES.timer);
    const jobId = `idle:${convId}:${seq}`;

    await queue.add(
      'idle',
      {
        type: 'idle',
        convId,
        seq,
        kind,
      },
      {
        jobId,
        delay,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );

    this.logger.debug(
      `已预约会话空闲超时检查 [jobId=${jobId}, convId=${convId}, kind=${kind}, delay=${delay}ms, seq=${seq}]`,
    );

    return seq;
  }

  /**
   * 调度 60s 人工未回复自动接回任务 (PRD §6.2、Task 3.5)
   * 采用 hwait:{convId}:{micEpoch} 为 jobId 实现幂等防重入（客户连续追问不重置）
   */
  async scheduleHumanWait(
    convId: number | string,
    senderId: string,
    micEpoch: number,
    delayMs?: number,
    force = false,
  ): Promise<void> {
    const delay = delayMs ?? (this.env.HUMAN_WAIT_TIMEOUT_MS ?? 60000);
    const queue = this.queueService.getQueue<HumanWaitJobData>(QUEUE_NAMES.timer);
    const jobId = `hwait:${convId}:${micEpoch}`;

    await queue.add(
      'hwait',
      {
        type: 'hwait',
        convId,
        senderId,
        micEpoch,
        force,
      },
      {
        jobId,
        delay,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );

    this.logger.debug(
      `已预约 60s 人工未回复接回检查 [jobId=${jobId}, delay=${delay}ms, micEpoch=${micEpoch}]`,
    );
  }

  /**
   * 人工在群内回复发言时，取消对应的 60s 接回任务
   */
  async cancelHumanWait(convId: number | string, micEpoch: number): Promise<void> {
    const queue = this.queueService.getQueue<HumanWaitJobData>(QUEUE_NAMES.timer);
    const jobId = `hwait:${convId}:${micEpoch}`;
    try {
      const job = await queue.getJob(jobId);
      if (job) {
        await job.remove();
        this.logger.debug(`已取消 60s 人工超时接回检查任务 [jobId=${jobId}]`);
      }
    } catch (err: any) {
      this.logger.warn(`取消 60s 任务失败: ${err.message}`);
    }
  }

  /**
   * 处理计时器任务到期触发
   */
  async handleTimerJob(job: Job<TimerJobData>): Promise<void> {
    const data = job.data;

    // 1. 处理会话空闲超时任务
    if (data.type === 'idle') {
      await this.handleIdleJob(data);
      return;
    }

    // 2. 处理 60s 人工未回复超时接回任务
    if (data.type === 'hwait') {
      await this.handleHumanWaitJob(data);
      return;
    }

    // 3. 处理缓冲池静默与熔断计时任务
    const meta = await this.bufferService.getMeta(data.convId, data.senderId);

    if (!meta || meta.count <= 0) {
      this.logger.debug(
        `缓冲池已空，忽略计时任务: type=${data.type}, convId=${data.convId}, senderId=${data.senderId}`,
      );
      return;
    }

    if (data.type === 'quiet') {
      // 静默计时器比对：版本号若已变化，说明客户在静默期内又发了新消息，丢弃旧任务
      if (data.version !== meta.version) {
        this.logger.debug(
          `静默检查版本已过期被重置，安全丢弃: jobVer=${data.version}, currentVer=${meta.version}`,
        );
        return;
      }

      this.logger.log(
        `⏱️ [静默超时] 达到静默窗口 (3s)，触发封组: convId=${data.convId}, senderId=${data.senderId}`,
      );
      await this.triggerSeal(data.convId, data.senderId, 'QUIET');
    } else if (data.type === 'hard') {
      // 熔断计时器比对：epoch 若已变化，说明此前已被静默或条数满额封组，安全丢弃
      if (data.epoch !== meta.epoch) {
        this.logger.debug(
          `熔断检查代号已变更，安全丢弃: jobEpoch=${data.epoch}, currentEpoch=${meta.epoch}`,
        );
        return;
      }

      this.logger.log(
        `🚨 [熔断超时] 达到最大容忍时长 (15s)，强制封组: convId=${data.convId}, senderId=${data.senderId}`,
      );
      await this.triggerSeal(data.convId, data.senderId, 'HARD');
    }
  }

  /**
   * 处理会话空闲超时逻辑（版本防竞态、状态跃迁至 ENDED、resolved 更新与缓存清理）
   */
  private async handleIdleJob(data: IdleJobData): Promise<void> {
    if (this.redisService) {
      const redis = this.redisService.getClient();
      const currentSeqRaw = await redis.get(REDIS_KEYS.idleSeq(data.convId));
      const currentSeq = currentSeqRaw ? parseInt(currentSeqRaw, 10) : 0;

      // 比对版本号：若已自增，说明等待期间有新消息到来，旧空闲任务安全丢弃
      if (data.seq !== currentSeq) {
        this.logger.debug(
          `会话空闲检查版本已过期被重置，安全丢弃: convId=${data.convId}, jobSeq=${data.seq}, currentSeq=${currentSeq}`,
        );
        return;
      }
    }

    if (!this.mysqlService || !this.stateTransitionService) {
      this.logger.warn(
        `未注入 mysqlService 或 stateTransitionService，跳过空闲超时流转: convId=${data.convId}`,
      );
      return;
    }

    const pool = this.mysqlService.getPool();
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT id, tenant_id, channel, channel_chat_id, status FROM conversation WHERE id = ?',
      [data.convId],
    );

    if (!rows || rows.length === 0) {
      this.logger.warn(`会话不存在 (#${data.convId})，清理残留空闲状态`);
      if (this.redisService) {
        const redis = this.redisService.getClient();
        await redis.del(REDIS_KEYS.idleSeq(data.convId));
      }
      return;
    }

    const conv = rows[0];
    if (conv.status !== 'ACTIVE') {
      this.logger.debug(
        `会话 #${data.convId} 当前状态为 ${conv.status}，非 ACTIVE 状态，忽略空闲超时触发`,
      );
      if (this.redisService) {
        const redis = this.redisService.getClient();
        await redis.del(REDIS_KEYS.idleSeq(data.convId));
      }
      return;
    }

    const endReason = data.kind === 'CLOSE' ? 'CLOSE_IDLE' : 'IDLE';
    this.logger.log(
      `⏱️ [会话空闲超时] 会话 #${data.convId} 达到空闲时限 (${data.kind})，触发关闭跃迁至 ENDED [原因=${endReason}]`,
    );

    // 调用状态流转服务将会话跃迁至 ENDED（乐观锁与审计落库）
    await this.stateTransitionService.transition(
      'CONVERSATION',
      data.convId,
      'ACTIVE',
      'ENDED',
      {
        tenantId: conv.tenant_id,
        operatorType: 'TIMEOUT',
        reason: endReason,
        metadata: {
          kind: data.kind,
          seq: data.seq,
        },
      },
    );

    // 若属于完结收尾（CLOSE_IDLE），标记 resolved = 1
    if (data.kind === 'CLOSE') {
      await pool.query('UPDATE conversation SET resolved = 1 WHERE id = ?', [data.convId]);
    } else {
      // 普通空闲结束（Q14）：客户不再回复默认已解决；转过人工的以客服回填为准，已有结论的不覆盖
      await pool.query(
        'UPDATE conversation SET resolved = 1 WHERE id = ? AND resolved IS NULL AND handoff = 0',
        [data.convId],
      );
    }

    // 清理 Redis 活跃会话映射及相关资源
    if (this.redisService) {
      const redis = this.redisService.getClient();
      await redis.del(REDIS_KEYS.activeConv(conv.tenant_id, conv.channel_chat_id));
      await redis.del(REDIS_KEYS.idleSeq(data.convId));
      await redis.del(REDIS_KEYS.mic(data.convId));
    }
  }

  /**
   * 处理 60s 人工未回复到期接回逻辑 (PRD §6.2、S9 用例)
   */
  private async handleHumanWaitJob(data: HumanWaitJobData): Promise<void> {
    if (!this.microphoneService) {
      this.logger.warn(`未注入 MicrophoneService，跳过 60s 人工超时接回: convId=${data.convId}`);
      return;
    }

    const micStatus = await this.microphoneService.getMicStatus(data.convId);

    // 校验：话筒依然为 HUMAN、epoch 匹配；锁定状态只有转人工等待（force）才允许解锁。
    // 人工期间发言会经 cancelHumanWait 取消本任务，所以到点仍在说明人工确实没回复
    if (
      micStatus.owner === 'HUMAN' &&
      micStatus.epoch === data.micEpoch &&
      (data.force || !micStatus.isHandoffLocked)
    ) {
      this.logger.log(
        `⏱️ [人工未回复超时] 会话 #${data.convId} 人工超时未回复${data.force ? '（转人工锁定已解除）' : ''}，话筒自动切回 BOT 并触发立即封组 (S9 用例)`,
      );
      // 1. 自动将话筒交还 BOT
      if (data.force) await this.microphoneService.returnToBot(data.convId, 'HANDOFF_TIMEOUT', true);
      else await this.microphoneService.returnToBot(data.convId, 'HUMAN_TIMEOUT');

      // 2. 立即将客户积累的消息封组回复（自动接回时不发占位应答）
      await this.triggerSeal(data.convId, data.senderId, 'HUMAN_TIMEOUT');
    } else {
      this.logger.debug(
        `[60s 人工超时接回检查] 状态已变更或被锁定，忽略接回: convId=${data.convId}, owner=${micStatus.owner}, epoch=${micStatus.epoch} (期望=${data.micEpoch}), locked=${micStatus.isHandoffLocked}`,
      );
    }
  }

  private async triggerSeal(
    convId: number | string,
    senderId: string,
    reason: SealReason,
  ): Promise<void> {
    if (this.sealer) {
      await this.sealer.seal(convId, senderId, reason);
    } else {
      this.logger.warn(`未注册 Sealer，跳过封组触发: convId=${convId}, senderId=${senderId}`);
    }
  }
}
