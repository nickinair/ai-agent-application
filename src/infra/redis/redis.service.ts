/**
 * @file redis.service.ts
 * @description 智能体全能平台 Redis 客户端与分布式锁服务
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §7.1、§7.4
 */

import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis, { type RedisOptions } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { ENV, type Env } from '../../config/env';

export interface DistributedLock {
  /** 锁标识唯一 Token */
  token: string;
  /** 释放锁（仅在持有者未发生篡改时安全释放） */
  release: () => Promise<boolean>;
  /** 锁续期（ms） */
  renew: (extendMs?: number) => Promise<boolean>;
}

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;

  constructor(@Inject(ENV) private readonly env: Env) {}

  /**
   * 获取或初始化 Redis 客户端单例
   */
  getClient(): Redis {
    if (!this.client) {
      const options: RedisOptions = {
        host: this.env.REDIS_HOST,
        port: this.env.REDIS_PORT,
        password: this.env.REDIS_PASSWORD || undefined,
        db: this.env.REDIS_DB,
        maxRetriesPerRequest: null, // BullMQ 必需配置
        enableReadyCheck: false,
        retryStrategy: (times) => Math.min(times * 100, 3000),
      };

      this.client = new Redis(options);

      this.client.on('connect', () => {
        this.logger.log(
          `Redis 已连接: ${this.env.REDIS_HOST}:${this.env.REDIS_PORT} [db=${this.env.REDIS_DB}]`,
        );
      });

      this.client.on('error', (err) => {
        this.logger.error(`Redis 错误: ${err.message}`, err.stack);
      });
    }

    return this.client;
  }

  /**
   * 抢占分布式排他锁（SET NX PX）
   * @param key 锁 Key（例如 ag:lock:conv:101）
   * @param ttlMs 锁有效时长，默认 10000ms（10秒）
   * @returns 获得锁则返回锁控制句柄，抢占失败则返回 null
   */
  async acquireLock(key: string, ttlMs: number = 10000): Promise<DistributedLock | null> {
    const client = this.getClient();
    const token = randomUUID();

    const res = await client.set(key, token, 'PX', ttlMs, 'NX');
    if (res !== 'OK') {
      return null;
    }

    const lock: DistributedLock = {
      token,
      release: async () => {
        const luaScript = `
          if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
          else
            return 0
          end
        `;
        const delRes = await client.eval(luaScript, 1, key, token);
        return delRes === 1;
      },
      renew: async (extendMs: number = ttlMs) => {
        const luaScript = `
          if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("pexpire", KEYS[1], ARGV[2])
          else
            return 0
          end
        `;
        const pexpireRes = await client.eval(luaScript, 1, key, token, extendMs);
        return pexpireRes === 1;
      },
    };

    return lock;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
  }
}
