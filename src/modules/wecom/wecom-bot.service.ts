import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { WSClient } from '@wecom/aibot-node-sdk';
import type { BaseMessage, EventMessage, TextMessage, WsFrame } from '@wecom/aibot-node-sdk';
import { ENV, type Env } from '../../config/env';
import { WecomGroupMessageService } from './wecom-group-message.service';
import type { WecomBotStatus } from './types/wecom.types';

@Injectable()
export class WecomBotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WecomBotService.name);
  private client: WSClient | null = null;

  private connected = false;
  private authenticated = false;
  private lastAuthenticatedAt: string | null = null;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly groupMessageService: WecomGroupMessageService,
  ) {}

  async onModuleInit(): Promise<void> {
    const { WECOM_BOT_ID, WECOM_BOT_SECRET, WECOM_BOT_WS_URL, WECOM_BOT_ENABLED } = this.env;

    if (!WECOM_BOT_ENABLED) {
      this.logger.log('企业微信智能机器人功能已通过环境变量配置显式禁用 (WECOM_BOT_ENABLED=false)');
      return;
    }

    if (!WECOM_BOT_ID || !WECOM_BOT_SECRET) {
      this.logger.warn(
        '未检测到 WECOM_BOT_ID 或 WECOM_BOT_SECRET 环境变量，企业微信长连接服务跳过启动。（如需启动请通过本地脚本 scripts/start-dev-wecom.sh 注入）',
      );
      return;
    }

    this.logger.log(`正在初始化企业微信智能机器人长连接客户端 (Bot ID: ${this.maskBotId(WECOM_BOT_ID)})...`);

    try {
      this.client = new WSClient({
        botId: WECOM_BOT_ID,
        secret: WECOM_BOT_SECRET,
        wsUrl: WECOM_BOT_WS_URL || undefined,
        logger: {
          debug: (msg: string, ...args: any[]) => this.logger.debug(`${msg} ${args.length ? JSON.stringify(args) : ''}`),
          info: (msg: string, ...args: any[]) => this.logger.log(`${msg} ${args.length ? JSON.stringify(args) : ''}`),
          warn: (msg: string, ...args: any[]) => this.logger.warn(`${msg} ${args.length ? JSON.stringify(args) : ''}`),
          error: (msg: string, ...args: any[]) => this.logger.error(`${msg} ${args.length ? JSON.stringify(args) : ''}`),
        },
      });

      this.setupEventListeners();
      this.client.connect();
      this.logger.log('企业微信 WebSocket 长连接发起建立...');
    } catch (error) {
      this.logger.error(`初始化企业微信智能机器人失败: ${(error as Error).message}`, (error as Error).stack);
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
    const isConfigured = Boolean(this.env.WECOM_BOT_ID && this.env.WECOM_BOT_SECRET);
    const msgStats = this.groupMessageService.getStats();

    return {
      configured: isConfigured,
      enabled: this.env.WECOM_BOT_ENABLED,
      connected: this.connected,
      authenticated: this.authenticated,
      botId: this.env.WECOM_BOT_ID ? this.maskBotId(this.env.WECOM_BOT_ID) : null,
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
