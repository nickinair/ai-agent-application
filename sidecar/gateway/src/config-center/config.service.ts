import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { RedisService } from '../infra/redis.service';
import type { ConfigChangeEvent, ConfigItem } from './config.types';

/**
 * a3 动态配置中心服务
 * 统一管理全局与各租户/组件命名空间配置，变更时通过 Redis Pub/Sub 频道广播通知。
 */
@Injectable()
export class ConfigService {
  private readonly logger = new Logger(ConfigService.name);

  /** 广播频道名（与主平台统一规范 ag:cfg:changed 对齐） */
  private readonly CHANGE_CHANNEL = 'ag:cfg:changed';

  /** 内存配置双缓存: namespace -> (key -> ConfigItem) */
  private readonly memoryConfigs = new Map<string, Map<string, ConfigItem>>();

  constructor(
    @Optional() @Inject(ENV) private readonly env?: Env,
    @Optional() private readonly redisService?: RedisService,
  ) {}

  /**
   * 获取指定命名空间下的单个配置项
   */
  async get<T = unknown>(namespace: string, key: string): Promise<ConfigItem<T> | null> {
    // 1. 内存优先
    const nsMap = this.memoryConfigs.get(namespace);
    if (nsMap && nsMap.has(key)) {
      return nsMap.get(key) as ConfigItem<T>;
    }

    // 2. 从 Redis Hash 载入
    if (this.redisService) {
      const hashKey = this.buildNamespaceHashKey(namespace);
      const raw = await this.redisService.hget(hashKey, key);
      if (raw) {
        try {
          const item = JSON.parse(raw) as ConfigItem<T>;
          this.setMemoryCache(namespace, key, item);
          return item;
        } catch {
          // parse error
        }
      }
    }

    return null;
  }

  /**
   * 获取指定命名空间下的全部配置项字典
   */
  async getAll(namespace: string): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};

    if (this.redisService) {
      const hashKey = this.buildNamespaceHashKey(namespace);
      const all = await this.redisService.hgetall(hashKey);
      for (const [k, v] of Object.entries(all)) {
        try {
          const item = JSON.parse(v) as ConfigItem;
          result[k] = item.value;
          this.setMemoryCache(namespace, k, item);
        } catch {
          result[k] = v;
        }
      }
      return result;
    }

    const nsMap = this.memoryConfigs.get(namespace);
    if (nsMap) {
      for (const [k, item] of nsMap.entries()) {
        result[k] = item.value;
      }
    }

    return result;
  }

  /**
   * 设置/更新单个配置项
   */
  async set<T = unknown>(
    namespace: string,
    key: string,
    value: T,
    comment?: string,
  ): Promise<ConfigItem<T>> {
    const prev = await this.get(namespace, key);
    const version = (prev?.version ?? 0) + 1;
    const now = Date.now();

    const item: ConfigItem<T> = {
      namespace,
      key,
      value,
      version,
      updatedAt: now,
      comment,
    };

    // 1. 写入内存
    this.setMemoryCache(namespace, key, item);

    // 2. 写入 Redis
    if (this.redisService) {
      const hashKey = this.buildNamespaceHashKey(namespace);
      const allNsKey = this.buildAllNamespacesKey();
      await this.redisService.hset(hashKey, key, JSON.stringify(item));
      await this.redisService.getClient().sadd(allNsKey, namespace);

      // 3. 广播变更事件
      const changeEvent: ConfigChangeEvent = {
        namespace,
        key,
        version,
        timestamp: now,
      };
      await this.redisService.publish(this.CHANGE_CHANNEL, JSON.stringify(changeEvent));
    }

    this.logger.log(`[配置中心] 配置已更新 [${namespace}.${key}] v${version}`);
    return item;
  }

  /**
   * 批量设置配置
   */
  async batchSet(
    namespace: string,
    configs: Record<string, unknown>,
    comment?: string,
  ): Promise<Record<string, unknown>> {
    for (const [key, value] of Object.entries(configs)) {
      await this.set(namespace, key, value, comment);
    }
    return configs;
  }

  /**
   * 删除配置项
   */
  async delete(namespace: string, key: string): Promise<boolean> {
    let deleted = false;

    const nsMap = this.memoryConfigs.get(namespace);
    if (nsMap && nsMap.has(key)) {
      nsMap.delete(key);
      deleted = true;
    }

    if (this.redisService) {
      const hashKey = this.buildNamespaceHashKey(namespace);
      const res = await this.redisService.hdel(hashKey, key);
      if (res > 0) deleted = true;

      // 广播删除事件
      const changeEvent: ConfigChangeEvent = {
        namespace,
        key,
        version: -1,
        timestamp: Date.now(),
      };
      await this.redisService.publish(this.CHANGE_CHANNEL, JSON.stringify(changeEvent));
    }

    this.logger.log(`[配置中心] 配置已删除 [${namespace}.${key}]`);
    return deleted;
  }

  /**
   * 列出所有命名空间
   */
  async listNamespaces(): Promise<string[]> {
    if (this.redisService) {
      const client = this.redisService.getClient();
      const list = await client.smembers(this.buildAllNamespacesKey());
      return list.sort();
    }
    return Array.from(this.memoryConfigs.keys()).sort();
  }

  private setMemoryCache(namespace: string, key: string, item: ConfigItem): void {
    if (!this.memoryConfigs.has(namespace)) {
      this.memoryConfigs.set(namespace, new Map());
    }
    this.memoryConfigs.get(namespace)!.set(key, item);
  }

  private buildNamespaceHashKey(namespace: string): string {
    return `a3:config:${namespace}`;
  }

  private buildAllNamespacesKey(): string {
    return 'a3:config:namespaces';
  }
}
