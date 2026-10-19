import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { WSClient } from '@wecom/aibot-node-sdk';
import type { BaseMessage, EventMessage, TextMessage, WsFrame } from '@wecom/aibot-node-sdk';
import { ENV, type Env } from '../../config/env';
import { WecomGroupMessageService } from './wecom-group-message.service';
import type { WecomBotStatus } from './types/wecom.types';
import { GatewayConfigService } from '../../infra/gateway/gateway-config.service';

@Injectable()
export class WecomBotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WecomBotService.name);
  private client: WSClient | null = null;

  private connected = false;
  private authenticated = false;
  private lastAuthenticatedAt: string | null = null;

  // 记录当前活跃客户端的凭证指纹，用于热更防重复重连
  private activeBotId: string | null = null;
  private activeBotSecret: string | null = null;
  private activeWsUrl: string | null = null;
  private activeEnabled: boolean = false;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly groupMessageService: WecomGroupMessageService,
    @Optional() private readonly gatewayConfig?: GatewayConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.startOrReloadClient();

    // 监听网关 CC wecom 命名空间配置热变更
    if (this.gatewayConfig) {
      this.gatewayConfig.onConfigChange('wecom', async (key, val) => {
        this.logger.log(`[WecomBotService] 收到企微配置变更通知 (${key})，检查并执行热重载...`);
        await this.startOrReloadClient();
      });
    }
  }

  /**
   * 解析当前配置（优先网关 CC，缺省 fallback 至本地 env）
   */
  private resolveConfig(): {
    botId?: string;
    botSecret?: string;
    wsUrl?: string;
    botEnabled: boolean;
  } {
    const botId =
      (this.gatewayConfig?.get('wecom', 'botId') as string) || this.env.WECOM_BOT_ID;
    const botSecret =
      (this.gatewayConfig?.get('wecom', 'botSecret') as string) || this.env.WECOM_BOT_SECRET;
    const wsUrl =
      (this.gatewayConfig?.get('wecom', 'botWsUrl') as string) || this.env.WECOM_BOT_WS_URL;
    // 本机 WECOM_BOT_ENABLED=false 时一律不连：一个机器人只能有一条长连接，由哪台机器持有按机器定，
    // 配置中心是所有实例共用的，不能把每台都打开；配置中心的 botEnabled 只用来整体关掉
    // （值可能是字符串，"false" / "0" / "off" 都算关）
    const rawEnabled = this.gatewayConfig?.get('wecom', 'botEnabled');
    const centerEnabled =
      rawEnabled === undefined || rawEnabled === null
        ? true
        : !['false', '0', 'off', 'no', ''].includes(String(rawEnabled).trim().toLowerCase());
    const botEnabled = this.env.WECOM_BOT_ENABLED !== false && centerEnabled;

    return { botId, botSecret, wsUrl, botEnabled };
  }

  /**
   * 启动或热重载长连接客户端
   */
  async startOrReloadClient(): Promise<void> {
    const { botId, botSecret, wsUrl, botEnabled } = this.resolveConfig();

    // 1. 如果已禁用或缺少凭证
    if (!botEnabled || !botId || !botSecret) {
      if (this.client) {
        this.logger.log('企微机器人配置已禁用或凭证已清空，正在断开并下线长连接...');
        await this.disconnectClient();
      } else {
        if (!botEnabled) {
          this.logger.log('企业微信智能机器人功能已显式禁用 (botEnabled=false)');
        } else {
          this.logger.warn(
            '未检测到 botId 或 botSecret，企业微信长连接服务保持待机状态（可通过网关 CC 动态录入开启）',
          );
        }
      }
      this.activeBotId = null;
      this.activeBotSecret = null;
      this.activeWsUrl = null;
      this.activeEnabled = false;
      return;
    }

    // 2. 检查配置是否发生实质变化，避免无意义的频繁重连
    if (
      this.client &&
      this.activeEnabled === botEnabled &&
      this.activeBotId === botId &&
      this.activeBotSecret === botSecret &&
      this.activeWsUrl === (wsUrl || null)
    ) {
      return;
    }

    // 3. 凭证或参数变更，先优雅断开旧连接
    if (this.client) {
      this.logger.log('检测到企业微信长连接参数变更，正在平滑重启长连接...');
      await this.disconnectClient();
    }

    this.logger.log(`正在初始化企业微信智能机器人长连接客户端 (Bot ID: ${this.maskBotId(botId)})...`);

    try {
      this.client = new WSClient({
        botId,
        secret: botSecret,
        wsUrl: wsUrl || undefined,
        logger: {
          debug: (msg: string, ...args: any[]) => this.logger.debug(`${msg} ${args.length ? JSON.stringify(args) : ''}`),
          info: (msg: string, ...args: any[]) => this.logger.log(`${msg} ${args.length ? JSON.stringify(args) : ''}`),
          warn: (msg: string, ...args: any[]) => this.logger.warn(`${msg} ${args.length ? JSON.stringify(args) : ''}`),
          error: (msg: string, ...args: any[]) => this.logger.error(`${msg} ${args.length ? JSON.stringify(args) : ''}`),
        },
      });

      this.activeBotId = botId;
      this.activeBotSecret = botSecret;
      this.activeWsUrl = wsUrl || null;
      this.activeEnabled = botEnabled;

      this.setupEventListeners();
      this.client.connect();
      this.logger.log('企业微信 WebSocket 长连接发起建立 (动态热重载成功)...');
    } catch (error) {
      this.logger.error(`初始化企业微信智能机器人失败: ${(error as Error).message}`, (error as Error).stack);
    }
  }

  private async disconnectClient(): Promise<void> {
    if (this.client) {
      try {
        this.client.disconnect();
      } catch (err) {
        this.logger.warn(`关闭长连接时发生异常: ${(err as Error).message}`);
      }
      this.client = null;
      this.connected = false;
      this.authenticated = false;
    }
  }


  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      this.logger.log('正在优雅关闭企业微信智能机器人 WebSocket 长连接...');
      try {
        this.client.disconnect();
      } catch (err) {
        this.logger.warn(`关闭长连接时发生异常: ${(err as Error).message}`);
      }
      this.client = null;
      this.connected = false;
      this.authenticated = false;
    }
  }

  /**
   * 绑定长连接与群聊消息事件监听
   */
  private setupEventListeners(): void {
    if (!this.client) return;

    this.client.on('connected', () => {
      this.connected = true;
      this.logger.log('企业微信 WebSocket 底层连接建立成功 (connected)');
    });

    this.client.on('authenticated', () => {
      this.authenticated = true;
      this.lastAuthenticatedAt = new Date().toISOString();
      this.logger.log('🎉 企业微信智能机器人认证成功！长连接已就绪 (authenticated)');
    });

    this.client.on('disconnected', (reason: string) => {
      this.connected = false;
      this.authenticated = false;
      this.logger.warn(`企业微信 WebSocket 连接断开: ${reason}`);
    });

    this.client.on('reconnecting', (attempt: number) => {
      this.logger.log(`企业微信 WebSocket 正在尝试第 ${attempt} 次重新连接...`);
    });

    this.client.on('error', (err: Error) => {
      this.logger.error(`企业微信 WebSocket 异常: ${err.message}`, err.stack);
    });

    // 全量消息统一监听（文本、语音、图片、文件、视频、图文混排等）
    this.client.on('message', async (frame: WsFrame<BaseMessage>) => {
      if (!this.client) return;
      await this.groupMessageService.handleIncomingMessage(this.client, frame);
    });

    // 事件推送监听（进入会话、卡片交互、用户反馈等）
    this.client.on('event', (frame: WsFrame<EventMessage>) => {
      const eventType = frame.body?.event?.eventtype || 'unknown_event';
      const fromUser = frame.body?.from?.userid || 'unknown_user';
      this.logger.log(`📢 收到企业微信事件回调 [事件类型=${eventType}] [用户=${fromUser}] [ReqID=${frame.headers?.req_id}]`);
    });
  }

  /**
   * 获取底层 WSClient 实例（供高级特性调用）
   */
  getClient(): WSClient | null {
    return this.client;
  }

  /**
   * 获取机器人运行状态
   */
  getStatus(): WecomBotStatus {
    const { botId, botSecret, botEnabled } = this.resolveConfig();
    const isConfigured = Boolean(botId && botSecret);
    const msgStats = this.groupMessageService.getStats();

    return {
      configured: isConfigured,
      enabled: botEnabled,
      connected: this.connected,
      authenticated: this.authenticated,
      botId: botId ? this.maskBotId(botId) : null,
      stats: {
        totalMessagesReceived: msgStats.receivedCount,
        totalRepliesSent: msgStats.repliedCount,
        totalHandoffCount: msgStats.handoffCount,
        lastMessageAt: msgStats.lastReceivedAt,
        lastAuthenticatedAt: this.lastAuthenticatedAt,
      },
    };
  }


  /**
   * 脱敏展示 Bot ID
   */
  private maskBotId(botId: string): string {
    if (botId.length <= 8) return '***';
    return `${botId.slice(0, 4)}****${botId.slice(-4)}`;
  }
}
