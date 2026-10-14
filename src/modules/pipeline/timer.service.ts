/**
 * @file timer.service.ts
 * @description 静默与熔断双计时器调度服务（基于 BullMQ 延时任务与版本号匹配机制）
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §7.2、§7.3
 */

import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job } from 'bullmq';
import { ENV, type Env } from '../../config/env';
import { QueueService, QUEUE_NAMES } from '../../infra/queue/queue.service';
import { BufferService } from './buffer.service';

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

export type TimerJobData = QuietJobData | HardJobData;

@Injectable()
export class TimerService implements OnModuleInit {
  private readonly logger = new Logger(TimerService.name);
  private sealer: ISealer | null = null;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly queueService: QueueService,
    private readonly bufferService: BufferService,
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
    const jobId = `quiet:${convId}:${senderId}:${version}`;

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
    const jobId = `hard:${convId}:${senderId}:${epoch}`;

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
   * 处理计时器任务到期触发
   */
  async handleTimerJob(job: Job<TimerJobData>): Promise<void> {
    const data = job.data;
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
