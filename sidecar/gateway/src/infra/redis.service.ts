import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import Redis, { type RedisOptions } from 'ioredis';
import { ENV, type Env } from '../config/env';

/**
 * a3 内部网关 Redis 客户端基础设施
 * 负责服务注册表状态管理、心跳租期、配置存取及 Pub/Sub 广播。
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;

  constructor(@Optional() @Inject(ENV) private readonly env?: Env) {}

  /**
   * 获取或初始化 Redis 连接实例
   */
  getClient(): Redis {
    if (!this.client) {
      const host = this.env?.REDIS_HOST || 'localhost';
      const port = this.env?.REDIS_PORT || 6379;
      const password = this.env?.REDIS_PASSWORD || undefined;
      const db = this.env?.REDIS_DB || 0;

      const options: RedisOptions = {
        host,
        port,
        password,
        db,
        enableReadyCheck: false,
        lazyConnect: true,
        retryStrategy: (times) => Math.min(times * 100, 2000),
      };

      this.client = new Redis(options);

      this.client.on('connect', () => {
        this.logger.log(`Redis 连接成功: ${host}:${port} [db=${db}]`);
      });

      this.client.on('error', (err) => {
        this.logger.error(`Redis 异常: ${err.message}`);
      });
    }

    return this.client;
  }

  /**
   * 允许注入已有的 Redis Client（主要用于测试）
   */
  setClient(client: Redis): void {
    this.client = client;
  }

  async get(key: string): Promise<string | null> {
    try {
      return await this.getClient().get(key);
    } catch (err) {
      this.logger.warn(`Redis get 失败 [key=${key}]: ${(err as Error).message}`);
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<string | null> {
    try {
      if (ttlSeconds && ttlSeconds > 0) {
        return await this.getClient().set(key, value, 'EX', ttlSeconds);
      }
      return await this.getClient().set(key, value);
    } catch (err) {
      this.logger.warn(`Redis set 失败 [key=${key}]: ${(err as Error).message}`);
      return null;
    }
  }

  async del(key: string): Promise<number> {
    try {
      return await this.getClient().del(key);
    } catch (err) {
      this.logger.warn(`Redis del 失败 [key=${key}]: ${(err as Error).message}`);
      return 0;
    }
  }

  async expire(key: string, seconds: number): Promise<number> {
    try {
      return await this.getClient().expire(key, seconds);
    } catch (err) {
      this.logger.warn(`Redis expire 失败 [key=${key}]: ${(err as Error).message}`);
      return 0;
    }
  }

  async ttl(key: string): Promise<number> {
    try {
      return await this.getClient().ttl(key);
    } catch (err) {
      this.logger.warn(`Redis ttl 失败 [key=${key}]: ${(err as Error).message}`);
      return -2;
    }
  }

  async keys(pattern: string): Promise<string[]> {
    try {
      return await this.getClient().keys(pattern);
    } catch (err) {
      this.logger.warn(`Redis keys 失败 [pattern=${pattern}]: ${(err as Error).message}`);
      return [];
    }
  }

  async hget(key: string, field: string): Promise<string | null> {
    try {
      return await this.getClient().hget(key, field);
    } catch (err) {
      this.logger.warn(`Redis hget 失败 [key=${key}, field=${field}]: ${(err as Error).message}`);
      return null;
    }
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    try {
      return await this.getClient().hset(key, field, value);
    } catch (err) {
      this.logger.warn(`Redis hset 失败 [key=${key}, field=${field}]: ${(err as Error).message}`);
      return 0;
    }
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    try {
      return await this.getClient().hdel(key, ...fields);
    } catch (err) {
      this.logger.warn(`Redis hdel 失败 [key=${key}]: ${(err as Error).message}`);
      return 0;
    }
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    try {
      return await this.getClient().hgetall(key);
    } catch (err) {
      this.logger.warn(`Redis hgetall 失败 [key=${key}]: ${(err as Error).message}`);
      return {};
    }
  }

  async publish(channel: string, message: string): Promise<number> {
    try {
      return await this.getClient().publish(channel, message);
    } catch (err) {
      this.logger.warn(`Redis publish 失败 [channel=${channel}]: ${(err as Error).message}`);
      return 0;
    }
  }

  async ping(): Promise<boolean> {
    try {
      const res = await this.getClient().ping();
      return res === 'PONG';
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      try {
        await this.client.quit();
      } catch {
        this.client.disconnect();
      }
      this.client = null;
    }
  }
}
