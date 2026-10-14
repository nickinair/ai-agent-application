import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { BaseMessage, WsFrame, WSClient } from '@wecom/aibot-node-sdk';
import { generateReqId } from '@wecom/aibot-node-sdk';
import { ENV, type Env } from '../../config/env';
import { InboundPipelineService } from '../pipeline/inbound-pipeline.service';
import type { InboundMessage } from '../../contracts';
import type {
  WecomGroupMessageHandler,
  WecomIncomingMessage,
} from './types/wecom.types';

@Injectable()
export class WecomGroupMessageService {
  private readonly logger = new Logger(WecomGroupMessageService.name);

  /** 最近处理过的 msgid 缓存，用于幂等去重（TTL 10 分钟） */
  private readonly processedMsgIds = new Map<string, number>();
  private readonly MSG_CACHE_TTL_MS = 10 * 60 * 1000;
  private readonly MAX_CACHE_SIZE = 5000;

  /** 业务处理器钩子列表 */
  private readonly handlers: WecomGroupMessageHandler[] = [];

  /** 消息收发统计指标 */
  private stats = {
    receivedCount: 0,
    repliedCount: 0,
    handoffCount: 0,
    lastReceivedAt: null as string | null,
  };

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Optional() private readonly pipelineService?: InboundPipelineService,
  ) {}

  /**
   * 注册自定义群聊消息处理器（如大模型调用、业务 Agent 流式处理等）
   */
  registerHandler(handler: WecomGroupMessageHandler): () => void {
    this.handlers.push(handler);
    return () => {
      const idx = this.handlers.indexOf(handler);
      if (idx !== -1) this.handlers.splice(idx, 1);
    };
  }

  /**
   * 清洗群聊中的 @ 标记，提取纯文本
   */
  cleanMentionText(rawContent: string): string {
    if (!rawContent) return '';
    // 过滤常见企微 @ 结构（例如 @智能助理、@Bot_001、@所有人）及紧跟的空格
    return rawContent
      .replace(/@[\w\u4e00-\u9fa5\-_]+(?:\s+|$)/gi, '')
      .trim();
  }

  /**
   * 判断并记录 msgid，实现消息防重
   * @returns true 表示是一条新消息；false 表示为重复消息，应忽略
   */
  checkAndRecordMsgId(msgId: string): boolean {
    if (!msgId) return true;
    const now = Date.now();
    this.cleanupExpiredMsgCache(now);

    if (this.processedMsgIds.has(msgId)) {
      this.logger.warn(`检测到企微重复推送的消息，直接忽略: msgId=${msgId}`);
      return false;
    }

    // 防止内存膨胀，超过上限时清除最早的 1000 条
    if (this.processedMsgIds.size >= this.MAX_CACHE_SIZE) {
      const oldestKeys = Array.from(this.processedMsgIds.keys()).slice(0, 1000);
      for (const k of oldestKeys) this.processedMsgIds.delete(k);
    }

    this.processedMsgIds.set(msgId, now);
    return true;
  }

  /**
   * 清理过期消息 ID 缓存
   */
  private cleanupExpiredMsgCache(now: number): void {
    for (const [id, timestamp] of this.processedMsgIds.entries()) {
      if (now - timestamp > this.MSG_CACHE_TTL_MS) {
        this.processedMsgIds.delete(id);
      }
    }
  }

  /**
   * 解析企业微信长连接下发的原始数据帧为统一的 WecomIncomingMessage
   * 覆盖官方文档 101834 的所有类型（文本、语音、图片、文件、视频、图文混排）
   */
  parseIncomingMessage(frame: WsFrame<BaseMessage>): WecomIncomingMessage | null {
    const body = frame.body;
    if (!body) return null;

    const msgId = body.msgid || '';
    const chatType = body.chattype || 'group';
    const chatId = body.chatid || '';
    const userId = body.from?.userid || '';
    const msgType = String(body.msgtype || 'unknown').toLowerCase();
    const createTime = body.create_time;

    let content = '';
    let requiresHumanHandoff = false;
    let mediaInfo: WecomIncomingMessage['mediaInfo'];

    // 按照官方文档 101834 分类解析
    switch (msgType) {
      case 'text': {
        content = body.text?.content || '';
        requiresHumanHandoff = false;
        break;
      }
      case 'voice': {
        // 企业微信服务端在语音消息中已自动转写文字在 content 中
        content = body.voice?.content || '';
        requiresHumanHandoff = false;
        break;
      }
      case 'image': {
        content = '[图片]';
        requiresHumanHandoff = true;
        mediaInfo = {
          url: body.image?.url,
          hasAesKey: Boolean(body.image?.aeskey),
        };
        break;
      }
      case 'file': {
        content = '[文件]';
        requiresHumanHandoff = true;
        mediaInfo = {
          url: body.file?.url,
          hasAesKey: Boolean(body.file?.aeskey),
        };
        break;
      }
      case 'video': {
        content = '[视频]';
        requiresHumanHandoff = true;
        mediaInfo = {
          url: body.video?.url,
          hasAesKey: Boolean(body.video?.aeskey),
        };
        break;
      }
      case 'mixed': {
        content = '[图文混排]';
        requiresHumanHandoff = true;
        mediaInfo = {
          mixedItemCount: Array.isArray(body.mixed?.msg_item) ? body.mixed.msg_item.length : 0,
        };
        break;
      }
      default: {
        content = `[未知类型: ${msgType}]`;
        requiresHumanHandoff = true;
        break;
      }
    }

    const cleanedContent = this.cleanMentionText(content);

    // 解析引用消息结构
    let quote: WecomIncomingMessage['quote'];
    if (body.quote) {
      quote = {
        msgType: body.quote.msgtype || '',
        text: body.quote.text?.content,
      };
    }

    return {
      msgId,
      chatType,
      chatId,
      userId,
      msgType,
      content,
      cleanedContent,
      requiresHumanHandoff,
      mediaInfo,
      quote,
      createTime,
      rawFrame: frame,
    };
  }

  /**
   * 结构化打印接收到的企业微信消息 Log
   */
  logIncomingMessage(msg: WecomIncomingMessage): void {
    const isGroup = msg.chatType === 'group';
    const targetLabel = isGroup ? `群聊 ID=${msg.chatId}` : '单聊';
    const handoffLabel = msg.requiresHumanHandoff
      ? '🛎️ [转人工介入处理]'
      : '🤖 [智能消息处理]';

    const lines: string[] = [
      `📩 收到企业微信消息 [类型=${msg.msgType.toUpperCase()}] [${targetLabel}] [用户=${msg.userId}] [MsgID=${msg.msgId}] ${handoffLabel}`,
    ];

    if (msg.msgType === 'text') {
      lines.push(`   ├─ 文本内容: "${msg.content}" (清洗后: "${msg.cleanedContent}")`);
    } else if (msg.msgType === 'voice') {
      lines.push(`   ├─ 语音转写: "${msg.content}" (清洗后: "${msg.cleanedContent}")`);
    } else if (msg.mediaInfo) {
      const { url, hasAesKey, mixedItemCount } = msg.mediaInfo;
      if (url) lines.push(`   ├─ 媒体下载地址: ${url} (加密密钥: ${hasAesKey ? '已提供' : '无'})`);
      if (mixedItemCount !== undefined) lines.push(`   ├─ 图文混排项数量: ${mixedItemCount}`);
    }

    if (msg.quote) {
      lines.push(`   ├─ 引用原消息: [${msg.quote.msgType}] "${msg.quote.text || ''}"`);
    }

    lines.push(`   └─ 时间戳: ${msg.createTime || Date.now()}`);

    this.logger.log(lines.join('\n'));
  }

  /**
   * 处理接收到的所有企业微信长连接消息帧
   */
  async handleIncomingMessage(client: WSClient, frame: WsFrame<BaseMessage>): Promise<void> {
    const parsed = this.parseIncomingMessage(frame);
    if (!parsed) return;

    // 仅处理群聊消息（按本平台群渠道架构）
    if (parsed.chatType !== 'group') {
      this.logger.debug(`忽略非群聊消息: chattype=${parsed.chatType}, msgid=${parsed.msgId}`);
      return;
    }

    // 防重排重检查
    if (!this.checkAndRecordMsgId(parsed.msgId)) {
      return;
    }

    this.stats.receivedCount++;
    this.stats.lastReceivedAt = new Date().toISOString();

    // 1. 结构化打印完整消息 Log
    this.logIncomingMessage(parsed);

    // 2. 注入平台核心缓冲流水线（第 1 关「收」）
    if (this.pipelineService) {
      try {
        const inboundMsg: InboundMessage = {
          tenantId: 1,
          channel: 'wecom_group',
          channelChatId: parsed.chatId,
          channelMsgId: parsed.msgId,
          chatName: (parsed as any).chatName,
          sender: {
            role: 'CUSTOMER',
            channelUserId: parsed.userId,
          },
          mentions: [],
          type: (parsed.msgType === 'mixed' ? 'other' : parsed.msgType) as any,
          text: parsed.cleanedContent,
          mediaUrl: parsed.mediaInfo?.url,
          sentAt: parsed.createTime || Date.now(),
        };
        await this.pipelineService.onInbound(inboundMsg);
      } catch (err: any) {
        this.logger.error(`投递核心流水线异常: ${err.message}`, err.stack);
      }
    }

    try {
      // 3. 策略分流与本地原型应答：
      // 非文本与语音类型的多媒体消息 -> 自动执行转人工处理（@客服标记的所有用户）
      if (parsed.requiresHumanHandoff) {
        await this.handleHandoffReply(client, parsed);
        return;
      }

      // 文本与语音消息 -> 智能应答逻辑（自定义处理器或默认流式打字机）
      if (this.handlers.length > 0) {
        for (const handler of this.handlers) {
          const replyText = await handler(parsed);
          if (replyText) {
            await this.replyStream(client, frame, replyText, true);
          }
        }
      } else {
        await this.handleDefaultReply(client, parsed);
      }
    } catch (error) {
      this.logger.error(
        `处理或回复企微群聊消息失败: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }

  /**
   * 转人工处理回复：在群内提示并 @客服标记的所有用户
   */
  async handleHandoffReply(client: WSClient, msg: WecomIncomingMessage): Promise<void> {
    const streamId = generateReqId('stream_handoff');
    const staffMentions = this.env.WECOM_STAFF_MENTIONS || '@客服';

    const handoffContent = [
      `🤖 收到您发送的**${this.getMsgTypeLabel(msg.msgType)}**消息。`,
      `当前暂不支持直接识别该类型，已为您转接人工客服处理。`,
      ``,
      `请稍候，${staffMentions} 老师请跟进支持！`,
    ].join('\n');

    await client.replyStream(msg.rawFrame, streamId, handoffContent, true);

    this.stats.handoffCount++;
    this.stats.repliedCount++;
    this.logger.log(
      `🛎️ [转人工提醒] 已向群 [${msg.chatId}] 发送转人工应答，并提醒客服人员: ${staffMentions}`,
    );
  }

  /**
   * 默认回复：模拟流式打字机应答（用于文本和语音消息）
   */
  private async handleDefaultReply(client: WSClient, msg: WecomIncomingMessage): Promise<void> {
    const streamId = generateReqId('stream');
    const typeLabel = msg.msgType === 'voice' ? '语音转写' : '文本';

    // 1. 发送思考中的中间状态（finish = false）
    await client.replyStream(msg.rawFrame, streamId, '🤖 正在思考...', false);

    // 2. 发送最终回复内容（finish = true）
    const replyContent = [
      `已收到您的群聊${typeLabel}消息：`,
      `> ${msg.cleanedContent || '(空内容)'}`,
      ``,
      `*企业微信群聊智能机器人模块接入正常运行中。*`,
    ].join('\n');

    await client.replyStream(msg.rawFrame, streamId, replyContent, true);

    this.stats.repliedCount++;
    this.logger.log(`成功回复企微群聊消息 [群ID=${msg.chatId}] [类型=${msg.msgType}]`);
  }

  /**
   * 辅助方法：获取消息类型的中文描述
   */
  private getMsgTypeLabel(msgType: string): string {
    switch (msgType) {
      case 'image':
        return '图片';
      case 'file':
        return '文件';
      case 'video':
        return '视频';
      case 'mixed':
        return '图文混排';
      default:
        return '多媒体';
    }
  }

  /**
   * 便捷流式回复封装
   */
  async replyStream(
    client: WSClient,
    frame: WsFrame<BaseMessage>,
    content: string,
    finish = true,
    streamId?: string,
  ): Promise<void> {
    const sid = streamId || generateReqId('stream');
    await client.replyStream(frame, sid, content, finish);
    if (finish) {
      this.stats.repliedCount++;
    }
  }

  /**
   * 向后兼容方法：处理旧版单调用的群聊文本消息
   */
  async handleGroupTextMessage(client: WSClient, frame: WsFrame<BaseMessage>): Promise<void> {
    return this.handleIncomingMessage(client, frame);
  }

  /**
   * 向后兼容方法：解析文本消息
   */
  parseGroupMessage(frame: WsFrame<BaseMessage>): WecomIncomingMessage | null {
    return this.parseIncomingMessage(frame);
  }

  /**
   * 处理会话内容存档 Sidecar 投递过来的全量消息事件 (R2 收端)
   */
  async handleFinanceInboundEvent(event: import('./types/wecom-finance-inbound.dto').InboundFinanceEventDto): Promise<{ success: boolean; handled: boolean }> {
    const isNew = this.checkAndRecordMsgId(event.msgid);
    if (!isNew) {
      this.logger.debug(`[会话存档] 忽略重复消息: ${event.msgid}`);
      return { success: true, handled: false };
    }

    const roomDesc = event.roomid
      ? `[群聊: ${event.roomid}]${event.isExternalRoom ? ' [外部客户群]' : ' [内部群]'}`
      : '[单聊]';

    this.logger.log(
      `📩 收到会话存档全量感知群消息 [Seq=${event.seq}] [MsgID=${event.msgid}] ${roomDesc} ` +
      `[用户=${event.sender}] [类型=${event.msgtype}] 摘要: ${event.contentSummary}`
    );

    this.stats.receivedCount++;
    this.stats.lastReceivedAt = new Date().toISOString();

    return { success: true, handled: true };
  }

  /**
   * 获取群聊消息统计数据
   */
  getStats() {
    return {
      receivedCount: this.stats.receivedCount,
      repliedCount: this.stats.repliedCount,
      handoffCount: this.stats.handoffCount,
      lastReceivedAt: this.stats.lastReceivedAt,
      cachedMsgCount: this.processedMsgIds.size,
    };
  }
}
