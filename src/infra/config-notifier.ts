import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { ENV, Env } from '../config/env';

/** 配置变更通知（与核心服务同一频道 ag:cfg:changed）：核心服务收到后丢弃对应缓存 */
export const CONFIG_CHANNEL = 'ag:cfg:changed';

@Injectable()
export class ConfigNotifier implements OnModuleDestroy {
  private readonly logger = new Logger(ConfigNotifier.name);
  private redis?: Redis;

  constructor(@Inject(ENV) private readonly env: Env) {}

  /** 通知失败只记日志：数据已经写库，核心服务缓存最迟 1 小时后自然失效 */
  async notify(tenantId: number, kind: 'member' | 'param' | 'rulepack' | 'llm_route'): Promise<void> {
    try {
      this.redis ??= new Redis(this.env.REDIS_URL ?? `redis://${this.env.REDIS_HOST}:${this.env.REDIS_PORT}`, { maxRetriesPerRequest: 1, lazyConnect: false });
      await this.redis.publish(CONFIG_CHANNEL, JSON.stringify({ tenantId, kind }));
    } catch (err) {
      this.logger.warn(`配置变更通知失败：${(err as Error).message}`);
    }
  }

  onModuleDestroy(): void {
    this.redis?.disconnect();
  }
}
