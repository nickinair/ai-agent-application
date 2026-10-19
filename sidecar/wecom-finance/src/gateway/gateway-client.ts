import { randomUUID } from 'crypto';
import Redis from 'ioredis';

export interface GatewayClientOptions {
  gatewayUrl?: string;
  enabled?: boolean;
  serviceName?: string;
  a3ServiceName?: string;
  namespace?: string;
  instanceId?: string;
  heartbeatIntervalMs?: number;
  authToken?: string;
  redisUrl?: string;
}

export interface DiscoveredInstance {
  instanceId: string;
  serviceName: string;
  host: string;
  port: number;
  metadata?: Record<string, any>;
}

/**
 * wecom-finance 网关统一客户端
 * 同时对接网关的两大核心能力：
 * 1. 动态配置中心 (CC): 启动时拉取远程配置与本地融合，并支持 Redis Pub/Sub 秒级热生效
 * 2. 服务注册发现中心 (SRF): 注册自身、周期心跳、动态发现下游 a3 实例地址
 */
export class GatewayClient {
  private gatewayUrl: string;
  private enabled: boolean;
  private serviceName: string;
  private a3ServiceName: string;
  private namespace: string;
  private instanceId: string;
  private heartbeatIntervalMs: number;
  private authToken?: string;
  private redisUrl?: string;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isRegistered: boolean = false;
  private redisSubscriber: Redis | null = null;
  private configListeners: Array<(configs: Record<string, unknown>) => void> = [];

  constructor(options: GatewayClientOptions = {}) {
    this.gatewayUrl = (options.gatewayUrl || 'http://127.0.0.1:3003').replace(/\/+$/, '');
    this.enabled = options.enabled !== false;
    this.serviceName = options.serviceName || 'wecom-finance';
    this.a3ServiceName = options.a3ServiceName || 'ai-agent-application';
    this.namespace = options.namespace || 'wecom-finance';
    this.instanceId = options.instanceId || `wf-${randomUUID().slice(0, 8)}`;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs || 10000;
    this.authToken = options.authToken;
    this.redisUrl = options.redisUrl;
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public getInstanceId(): string {
    return this.instanceId;
  }

  /**
   * 注册配置动态更新回调
   */
  public onConfigUpdate(listener: (configs: Record<string, unknown>) => void): void {
    this.configListeners.push(listener);
  }

  /**
   * 启动 Redis 频道订阅监听 (ag:cfg:changed)
   */
  public startConfigSubscriber(customRedisUrl?: string): void {
    if (!this.enabled || this.redisSubscriber) return;

    const targetUrl = customRedisUrl || this.redisUrl || process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    try {
      this.redisSubscriber = new Redis(targetUrl, {
        lazyConnect: false,
        maxRetriesPerRequest: null,
      });

      this.redisSubscriber.on('connect', () => {
        console.log(`[GatewayClient][CC] Redis 订阅连接就绪: ${targetUrl}`);
      });

      this.redisSubscriber.on('error', (err) => {
        console.warn(`[GatewayClient][CC] Redis 订阅异常: ${err.message}`);
      });

      const channel = 'ag:cfg:changed';
      this.redisSubscriber.subscribe(channel, (err) => {
        if (!err) {
          console.log(`[GatewayClient][CC] 成功订阅网关配置变更频道: ${channel}`);
        }
      });

      this.redisSubscriber.on('message', async (chan, msg) => {
        if (chan === channel) {
          try {
            const event = JSON.parse(msg);
            if (event.namespace === this.namespace || event.namespace === '*') {
              console.log(
                `[GatewayClient][CC] 监听到命名空间 [${this.namespace}] 配置变更通知 (v${event.version})，触发热重载...`,
              );
              const updated = await this.fetchRemoteConfig();
              for (const listener of this.configListeners) {
                try {
                  listener(updated);
                } catch (lErr: any) {
                  console.error(`[GatewayClient][CC] 执行配置回调失败: ${lErr.message}`);
                }
              }
            }
          } catch {
            // 忽略非 JSON 广播
          }
        }
      });
    } catch (err: any) {
      console.warn(`[GatewayClient][CC] 启动 Redis 订阅器失败: ${err.message}`);
    }
  }

  /**
   * 停止 Redis 广播监听
   */
  public stopConfigSubscriber(): void {
    if (this.redisSubscriber) {
      try {
        this.redisSubscriber.disconnect();
      } catch {}
      this.redisSubscriber = null;
    }
  }


  /**
   * ==========================================
   * 1. 动态配置中心 (CC) 能力
   * ==========================================
   */
  public async fetchRemoteConfig(): Promise<Record<string, unknown>> {
    if (!this.enabled) return {};

    const url = `${this.gatewayUrl}/api/config/${this.namespace}`;
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.buildHeaders(),
      });

      if (!response.ok) {
        console.warn(
          `[GatewayClient][CC] 获取命名空间 [${this.namespace}] 配置失败: HTTP ${response.status}`,
        );
        return {};
      }

      const resBody = (await response.json()) as { success: boolean; data?: Record<string, unknown> };
      if (resBody.success && resBody.data) {
        console.log(
          `[GatewayClient][CC] 成功从网关配置中心加载 [${this.namespace}] 配置，共 ${Object.keys(resBody.data).length} 项`,
        );
        return resBody.data;
      }
      return {};
    } catch (err: any) {
      console.warn(
        `[GatewayClient][CC] 连接网关配置中心异常 (${url})，降级使用本地配置: ${err.message}`,
      );
      return {};
    }
  }

  /**
   * ==========================================
   * 2. 服务注册与保活 (SRF) 能力
   * ==========================================
   */
  public async register(): Promise<boolean> {
    if (!this.enabled) return false;

    const url = `${this.gatewayUrl}/api/registry/register`;
    const payload = {
      instanceId: this.instanceId,
      serviceName: this.serviceName,
      host: '127.0.0.1',
      port: 0,
      metadata: {
        type: 'sidecar-collector',
        role: 'wecom-finance',
      },
      ttlSeconds: 30,
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        this.isRegistered = true;
        console.log(
          `[GatewayClient][SRF] ✅ 成功向网关注册自身实例: [${this.serviceName}] ${this.instanceId}`,
        );
        return true;
      }

      const errText = await response.text().catch(() => '');
      console.warn(`[GatewayClient][SRF] 注册实例失败: HTTP ${response.status}: ${errText}`);
      return false;
    } catch (err: any) {
      console.warn(
        `[GatewayClient][SRF] 网关注册服务不可达 (${url})，跳过注册继续运行: ${err.message}`,
      );
      return false;
    }
  }

  public async heartbeat(): Promise<boolean> {
    if (!this.enabled) return false;

    const url = `${this.gatewayUrl}/api/registry/heartbeat`;
    const payload = {
      instanceId: this.instanceId,
      serviceName: this.serviceName,
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        return true;
      }

      if (response.status === 404 || response.status === 400) {
        console.warn(`[GatewayClient][SRF] 实例租约已失效，尝试重新注册: ${this.instanceId}`);
        return await this.register();
      }

      return false;
    } catch (err: any) {
      return false;
    }
  }

  public startHeartbeat(): void {
    if (!this.enabled || this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(async () => {
      await this.heartbeat();
    }, this.heartbeatIntervalMs);
    if (this.heartbeatTimer.unref) {
      this.heartbeatTimer.unref();
    }
  }

  public stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  public async deregister(): Promise<boolean> {
    if (!this.enabled || !this.isRegistered) return false;

    const url = `${this.gatewayUrl}/api/registry/deregister`;
    const payload = {
      instanceId: this.instanceId,
      serviceName: this.serviceName,
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        this.isRegistered = false;
        console.log(`[GatewayClient][SRF] 实例 ${this.instanceId} 已从网关注销`);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * ==========================================
   * 3. 服务发现 (SRF): 动态发现 a3 Webhook 目标地址
   * ==========================================
   */
  public async discoverA3WebhookUrl(): Promise<string | null> {
    if (!this.enabled) return null;

    const url = `${this.gatewayUrl}/api/registry/instances/${this.a3ServiceName}`;
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.buildHeaders(),
      });

      if (!response.ok) {
        return null;
      }

      const resBody = (await response.json()) as { success: boolean; data?: DiscoveredInstance[] };
      if (!resBody.success || !Array.isArray(resBody.data) || resBody.data.length === 0) {
        return null;
      }

      // 获取第一个活跃实例
      const instance = resBody.data[0];
      const webhookPath = instance.metadata?.webhookPath || '/api/admin/wecom/finance-inbound';
      const resolvedUrl = `http://${instance.host}:${instance.port}${webhookPath}`;
      return resolvedUrl;
    } catch {
      return null;
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'wecom-finance-sidecar/1.0',
    };
    if (this.authToken) {
      headers['x-gateway-token'] = this.authToken;
    }
    return headers;
  }
}
