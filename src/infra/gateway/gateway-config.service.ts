import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { EventEmitter } from 'node:events';
import Redis from 'ioredis';
import { ENV, type Env } from '../../config/env';

/** 配置变更事件通知（频道与网关及核心服务统一规范 ag:cfg:changed 对齐） */
export const CONFIG_CHANNEL = 'ag:cfg:changed';

/** 网关广播变更结构 */
export interface GatewayConfigChangeEvent {
  namespace: string;
  key?: string;
  version: number;
  timestamp: number;
}

export type ConfigChangeListener = (key: string, value: unknown, allConfigs: Record<string, unknown>) => void;

/**
 * A3 伴生网关动态配置中心客户端 (CC Client)
 * 职责：
 * 1. 启动时并发预拉取网关命名空间配置 (wecom, runtime 等)，写入内存双层缓存；
 * 2. 具备 Fail-safe 容错机制：网关不可达时不阻断启动，平滑降级使用本地环境变量 (env.ts)；
 * 3. 建立独立的 Redis 订阅连接监听 ag:cfg:changed 频道；
 * 4. 监听到变更广播后异步热刷新配置，并触发已注册的模块监听回调 (如 WecomBot 重构长连接)。
 */
@Injectable()
export class GatewayConfigService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(GatewayConfigService.name);
  private readonly gatewayUrl: string;
  private readonly emitter = new EventEmitter();

  /** 内存两级缓存: namespace -> (key -> value) */
  private readonly memoryConfigs = new Map<string, Map<string, unknown>>();

  /** 监听的重点命名空间列表 */
  private readonly watchedNamespaces = new Set<string>(['wecom', 'runtime']);

  private subscriber: Redis | null = null;
  private isSubscribed = false;

  constructor(@Optional() @Inject(ENV) private readonly env?: Env) {
    this.gatewayUrl = (this.env?.GATEWAY_URL || 'http://localhost:3003').replace(/\/+$/, '');
  }

  /**
   * 应用启动阶段并发拉取配置并建立 Redis 变更监听
   */
  async onApplicationBootstrap(): Promise<void> {
    if (this.env?.GATEWAY_ENABLED === false) {
      this.logger.log('GATEWAY_ENABLED=false，跳过从网关动态配置中心拉取与监听');
      return;
    }

    // 1. 并发预拉取核心命名空间配置
    await Promise.all(
      Array.from(this.watchedNamespaces).map((ns) => this.fetchNamespaceConfig(ns)),
    );

    // 2. 启动 Redis 广播监听
    this.startRedisSubscriber();
  }

  /**
   * 应用退出前释放 Redis 订阅连接
   */
  async beforeApplicationShutdown(): Promise<void> {
    if (this.subscriber) {
      try {
        await this.subscriber.unsubscribe(CONFIG_CHANNEL);
        this.subscriber.disconnect();
        this.isSubscribed = false;
        this.logger.log('已优雅注销网关配置变更 Redis 订阅连接');
      } catch (err) {
        this.logger.warn(`关闭 Redis 订阅连接时异常: ${(err as Error).message}`);
      }
      this.subscriber = null;
    }
  }

  /**
   * 获取指定命名空间下的配置项
   * @param namespace 命名空间 (如 'wecom', 'runtime')
   * @param key 配置项键名
   * @param fallback 当网关未配置或暂不可达时的兜底默认值
   */
  get<T = unknown>(namespace: string, key: string, fallback?: T): T {
    const nsMap = this.memoryConfigs.get(namespace);
    if (nsMap && nsMap.has(key)) {
      const val = nsMap.get(key);
      if (val !== undefined && val !== null) {
        return val as T;
      }
    }
    return fallback as T;
  }

  /**
   * 获取某命名空间下的全量配置字典
   */
  getAll(namespace: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const nsMap = this.memoryConfigs.get(namespace);
    if (nsMap) {
      for (const [k, v] of nsMap.entries()) {
        result[k] = v;
      }
    }
    return result;
  }

  /**
   * 注册配置变更监听器
   * 当指定命名空间或特定项发生变更时触发
   */
  onConfigChange(namespace: string, listener: ConfigChangeListener): void {
    this.watchedNamespaces.add(namespace);
    this.emitter.on(`config:${namespace}`, listener);
  }

  /**
   * 移除配置变更监听器
   */
  offConfigChange(namespace: string, listener: ConfigChangeListener): void {
    this.emitter.off(`config:${namespace}`, listener);
  }

  /**
   * 从网关 CC 服务端拉取指定命名空间全量配置
   */
  async fetchNamespaceConfig(namespace: string): Promise<Record<string, unknown>> {
    const url = `${this.gatewayUrl}/api/config/${namespace}`;
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.buildHeaders(),
      });

      if (!response.ok) {
        this.logger.warn(
          `拉取网关命名空间 [${namespace}] 配置失败 (HTTP ${response.status})，降级使用本地默认配置`,
        );
        return {};
      }

      const resBody = (await response.json()) as { success: boolean; data?: Record<string, unknown> };
      if (resBody.success && resBody.data) {
        this.setMemoryCache(namespace, resBody.data);
        const count = Object.keys(resBody.data).length;
        this.logger.log(`[配置中心] 成功同步命名空间 [${namespace}] 配置 (共 ${count} 项)`);
        return resBody.data;
      }
      return {};
    } catch (err) {
      this.logger.warn(
        `连接网关配置中心异常 (${url}): ${(err as Error).message}，平滑降级使用本地配置`,
      );
      return {};
    }
  }

  /**
   * 启动 Redis 广播订阅
   */
  private startRedisSubscriber(): void {
    if (this.subscriber || this.isSubscribed) return;

    try {
      const redisUrl =
        this.env?.REDIS_URL ||
        `redis://${this.env?.REDIS_HOST || '127.0.0.1'}:${this.env?.REDIS_PORT || 6379}`;

      this.subscriber = new Redis(redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
        lazyConnect: false,
      });

      this.subscriber.on('connect', () => {
        this.logger.log(`Redis 订阅客户端已连接: ${redisUrl}`);
      });

      this.subscriber.on('error', (err) => {
        this.logger.warn(`Redis 订阅客户端异常: ${(err as Error).message}`);
      });

      this.subscriber.subscribe(CONFIG_CHANNEL, (err, count) => {
        if (err) {
          this.logger.error(`订阅配置变更频道 [${CONFIG_CHANNEL}] 失败: ${err.message}`);
        } else {
          this.isSubscribed = true;
          this.logger.log(`成功订阅配置变更频道 [${CONFIG_CHANNEL}]，当前频道数: ${count}`);
        }
      });

      this.subscriber.on('message', (channel, message) => {
        if (channel === CONFIG_CHANNEL) {
          this.handleChannelMessage(message);
        }
      });
    } catch (err) {
      this.logger.warn(`初始化 Redis 订阅器失败: ${(err as Error).message}`);
    }
  }

  /**
   * 处理 Redis 频道接收到的变更广播
   */
  async handleChannelMessage(message: string): Promise<void> {
    try {
      const payload = JSON.parse(message);

      // 1. 如果是网关 CC 广播的 GatewayConfigChangeEvent
      if (payload && typeof payload.namespace === 'string') {
        const { namespace, key, version } = payload as GatewayConfigChangeEvent;
        this.logger.log(
          `[配置中心] 监听到变更广播 [${namespace}${key ? '.' + key : ''}] v${version}，触发热重载...`,
        );

        // 重新向网关拉取该命名空间全量配置
        const updatedConfigs = await this.fetchNamespaceConfig(namespace);

        // 触发本地注册的回调事件
        this.emitter.emit(
          `config:${namespace}`,
          key || '*',
          key ? updatedConfigs[key] : updatedConfigs,
          updatedConfigs,
        );
      }
    } catch (err) {
      this.logger.warn(`解析配置变更通知消息异常: ${(err as Error).message}`);
    }
  }

  private setMemoryCache(namespace: string, configs: Record<string, unknown>): void {
    if (!this.memoryConfigs.has(namespace)) {
      this.memoryConfigs.set(namespace, new Map());
    }
    const nsMap = this.memoryConfigs.get(namespace)!;
    for (const [k, v] of Object.entries(configs)) {
      nsMap.set(k, v);
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'ai-agent-application/1.0',
    };
    const token = this.env?.GATEWAY_AUTH_TOKEN;
    if (token) {
      headers['x-gateway-token'] = token;
    }
    return headers;
  }
}
