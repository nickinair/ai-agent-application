/**
 * @file queue.service.ts
 * @description 基于 BullMQ 的队列与异步任务基础设施服务
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §7.2 BullMQ 队列与任务
 */

import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, type Processor, type WorkerOptions } from 'bullmq';
import { ENV, type Env } from '../../config/env';
import { RedisService } from '../redis/redis.service';

export const QUEUE_NAMES = {
  /** 延时计时器队列（静默/熔断/占位/等待） */
  timer: 'agent.queue.timer',
  /** 六道关流水线执行队列 */
  turn: 'agent.queue.turn',
  /** 入站接收队列 */
  inbound: 'agent.queue.inbound',
  /** 轮次善后投递队列 */
  post: 'agent.queue.post',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly queues = new Map<string, Queue>();
  private readonly workers = new Map<string, Worker>();

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly redisService: RedisService,
  ) {}

  /**
   * 获取或创建指定名称的 BullMQ 队列实例
   */
  getQueue<T = any>(name: string): Queue<T> {
    if (!this.queues.has(name)) {
      const queue = new Queue<T>(name, {
        connection: this.redisService.getClient(),
      });
      this.queues.set(name, queue);
      this.logger.log(`BullMQ 队列初始化: ${name}`);
    }
    return this.queues.get(name) as Queue<T>;
  }

  /**
   * 创建并注册指定队列的 Worker 消费者
   */
  createWorker<T = any, R = any>(
    name: string,
    processor: Processor<T, R>,
    opts?: Partial<WorkerOptions>,
  ): Worker<T, R> {
    if (this.workers.has(name)) {
      throw new Error(`Worker 已存在，不可重复注册: ${name}`);
    }

    const worker = new Worker<T, R>(name, processor, {
      connection: this.redisService.getClient(),
      concurrency: opts?.concurrency || 5,
      ...opts,
    });

    worker.on('failed', (job, err) => {
      this.logger.error(`队列 ${name} 任务 [id=${job?.id}] 处理失败: ${err.message}`, err.stack);
    });

    this.workers.set(name, worker as Worker);
    this.logger.log(`BullMQ Worker 已启动: ${name}`);
    return worker;
  }

  async onModuleDestroy(): Promise<void> {
    for (const [name, worker] of this.workers.entries()) {
      await worker.close();
      this.logger.log(`Worker 已停止: ${name}`);
    }
    this.workers.clear();

    for (const [name, queue] of this.queues.entries()) {
      await queue.close();
      this.logger.log(`Queue 已关闭: ${name}`);
    }
    this.queues.clear();
  }
}
