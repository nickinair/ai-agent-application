import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ENV, type Env } from '../../config/env';

/**
 * a3 网关服务注册与保活客户端服务 (SRF)
 * 负责在应用启动时向 sidecar/gateway 注册 a3 实例，维持周期性心跳保活并在退出时主动下线。
 * 全流程采用 Fail-safe 非阻塞容错，网关不可达时不影响 a3 核心业务运行。
 */
@Injectable()
export class GatewayRegistryService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(GatewayRegistryService.name);
  private readonly instanceId: string;
  private readonly serviceName: string;
  private readonly gatewayUrl: string;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isRegistered: boolean = false;

  constructor(@Optional() @Inject(ENV) private readonly env?: Env) {
    this.gatewayUrl = (this.env?.GATEWAY_URL || 'http://localhost:3003').replace(/\/+$/, '');
    this.serviceName = this.env?.GATEWAY_SERVICE_NAME || 'ai-agent-application';
    this.instanceId = this.env?.GATEWAY_INSTANCE_ID || `a3-${randomUUID().slice(0, 8)}`;
  }

  /**
   * 应用启动阶段触发注册
   */
  async onApplicationBootstrap(): Promise<void> {
    if (this.env?.GATEWAY_ENABLED === false) {
      this.logger.log('GATEWAY_ENABLED=false，跳过网关注册与心跳');
      return;
    }

    await this.register();
    this.startHeartbeat();
  }

  /**
   * 应用退出前触发注销
   */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopHeartbeat();
    if (this.isRegistered) {
      await this.deregister();
    }
  }

  /**
   * 获取当前实例 ID
   */
  getInstanceId(): string {
    return this.instanceId;
  }

  /**
   * 获取服务名
   */
  getServiceName(): string {
    return this.serviceName;
  }

  /**
   * 向网关注册服务实例
   */
  async register(): Promise<boolean> {
    const url = `${this.gatewayUrl}/api/registry/register`;
    const host = this.env?.GATEWAY_HOST || '127.0.0.1';
    const port = this.env?.PORT || 3002;

    const payload = {
      instanceId: this.instanceId,
      serviceName: this.serviceName,
      host,
      port,
      metadata: {
        version: '1.0.0',
        type: 'app-backend',
        webhookPath: '/api/admin/wecom/finance-inbound',
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
        this.logger.log(
          `✅ 成功向网关注册服务实例: [${this.serviceName}] ${this.instanceId} -> ${host}:${port}`,
        );
        return true;
      }

      const errText = await response.text().catch(() => '');
      this.logger.warn(`向网关注册失败: 状态码 ${response.status}: ${errText}`);
      return false;
    } catch (err: any) {
      this.logger.warn(
        `网关服务暂不可达 (${url})，跳过注册继续运行 (Fail-safe): ${err.message}`,
      );
      return false;
    }
  }

  /**
   * 发送心跳续约
   */
  async heartbeat(): Promise<boolean> {
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
        this.logger.debug(`[Heartbeat] 实例 ${this.instanceId} 心跳续约成功`);
        return true;
      }

      // 若网关返回 404 或心跳拒绝（租约已过期剔除），重新尝试 register
      if (response.status === 404 || response.status === 400) {
        this.logger.warn(`实例租约可能已过期，尝试重新注册: ${this.instanceId}`);
        return await this.register();
      }

      return false;
    } catch (err: any) {
      this.logger.debug(`心跳续约网络异常: ${err.message}`);
      return false;
    }
  }

  /**
   * 主动注销实例
   */
  async deregister(): Promise<boolean> {
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
        this.logger.log(`实例 ${this.instanceId} 已从网关成功注销`);
        return true;
      }
      return false;
    } catch (err: any) {
      this.logger.debug(`注销实例请求异常: ${err.message}`);
      return false;
    }
  }

  /**
   * 启动周期性心跳
   */
  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    const intervalMs = this.env?.GATEWAY_HEARTBEAT_INTERVAL_MS || 10000;
    this.heartbeatTimer = setInterval(async () => {
      await this.heartbeat();
    }, intervalMs);
    // 允许 Node 进程在无其他事件时正常退出
    if (this.heartbeatTimer.unref) {
      this.heartbeatTimer.unref();
    }
  }

  /**
   * 停止周期性心跳
   */
  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'a3-core/1.0',
    };
    if (this.env?.GATEWAY_AUTH_TOKEN) {
      headers['x-gateway-token'] = this.env.GATEWAY_AUTH_TOKEN;
    }
    return headers;
  }
}
