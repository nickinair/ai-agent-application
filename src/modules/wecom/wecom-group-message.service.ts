import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { BaseMessage, WsFrame, WSClient } from '@wecom/aibot-node-sdk';
import { ENV, type Env } from '../../config/env';
import { InboundPipelineService } from '../pipeline/inbound-pipeline.service';
import { WecomMemberRoleService } from './wecom-member-role.service';
import type { InboundMessage } from '../../contracts';
import type { WecomIncomingMessage } from './types/wecom.types';
import { MEDIA_SCHEME, saveMedia, type SavedMedia } from './media-store';

@Injectable()
export class WecomGroupMessageService {
  private readonly logger = new Logger(WecomGroupMessageService.name);

  /** 最近处理过的 msgid 缓存，用于幂等去重（TTL 10 分钟） */
  private readonly processedMsgIds = new Map<string, number>();
  private readonly MSG_CACHE_TTL_MS = 10 * 60 * 1000;
  private readonly MAX_CACHE_SIZE = 5000;

  /**
   * 跨通道内容指纹（群 + 发送人 + 去空白正文）→ 首次到达时间。
   * 同一条群消息会经「智能机器人长连接」和「会话存档侧车」两路到达，两路 msgid 格式不同
   * （长连接是 32 位 hex，会话存档是 数字_时间戳），msgid 去重和 uk_channel_msg 都拦不住，
   * 会被封成两组、回复两次。这里按内容指纹在短窗口内去重，先到的一路生效。
   */
  private readonly contentFingerprints = new Map<string, number>();
  private readonly CROSS_CHANNEL_WINDOW_MS = 10_000;

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
    @Optional() private readonly memberRoles?: WecomMemberRoleService,
  ) {}

  /**
   * 清洗群聊中的 @ 标记，提取纯文本
   */
  cleanMentionText(rawContent: string): string {
    if (!rawContent) return '';
    // 先去掉机器人全名（名字里可能有空格，如「车和网 CRM-agent」），再过滤常见企微 @ 结构（例如 @智能助理、@Bot_001、@所有人）及紧跟的空格
    const botName = this.env.WECOM_BOT_NAME?.trim();
    const text = botName ? rawContent.split(`@${botName}`).join(' ') : rawContent;
    return text
      .replace(/@[\w\u4e00-\u9fa5\-_]+(?:\s+|$)/gi, '')
      .trim();
  }

  /**
   * 群消息是否 @ 了机器人。长连接能收到群里的全部消息，不能一律当作 @机器人，
   * 否则员工普通发言不再抢话筒（Q13）。配了 WECOM_BOT_NAME 时按名字精确判断；没配时任何 @（@所有人 除外）都算。
   */
  mentionsBot(rawContent: string): boolean {
    if (!rawContent) return false;
    const botName = this.env.WECOM_BOT_NAME?.trim();
    if (botName) return rawContent.includes(`@${botName}`);
    return /@(?!所有人)[\w\u4e00-\u9fa5\-_]+/.test(rawContent);
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
    for (const [fp, timestamp] of this.contentFingerprints.entries()) {
      if (now - timestamp > this.CROSS_CHANNEL_WINDOW_MS) {
        this.contentFingerprints.delete(fp);
      }
    }
  }

  /**
   * 跨通道去重：同群、同发送人、同正文在窗口内只放行第一次
   * @returns true 表示首次到达；false 表示另一通道已投递过，应忽略
   */
  checkAndRecordContent(chatId: string, userId: string, text: string, source: string): boolean {
    const body = (text || '').replace(/\s+/g, '');
    if (!chatId || !userId || !body) return true;
    const now = Date.now();
    this.cleanupExpiredMsgCache(now);
    const fp = `${chatId}|${userId}|${body}`;
    const seen = this.contentFingerprints.get(fp);
    if (seen !== undefined && now - seen <= this.CROSS_CHANNEL_WINDOW_MS) {
      this.logger.warn(`检测到跨通道重复消息（${source}），直接忽略: chat=${chatId}, user=${userId}, text="${text.slice(0, 30)}"`);
      return false;
    }
    this.contentFingerprints.set(fp, now);
    return true;
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
    // requiresHumanHandoff 只是"非文本媒体"标记，不会触发转人工；图片由核心服务看图处理
    const handoffLabel = msg.requiresHumanHandoff
      ? '🖼️ [媒体消息]'
      : '🤖 [文本消息]';

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

    // 仅处理群聊与私聊机器人的单聊消息
    const isGroup = parsed.chatType === 'group';
    const isSingle = parsed.chatType === 'single';
    if (!isGroup && !isSingle) {
      this.logger.debug(`忽略非群聊/单聊消息: chattype=${parsed.chatType}, msgid=${parsed.msgId}`);
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

    // 2. 识别租户与发送人角色，注入平台核心缓冲流水线（第 1 关「收」）。
    //    回复一律由流水线（核心服务理解 + 发送端）发出，这里不再本地应答。
    if (this.pipelineService) {
      try {
        const tenantId = this.memberRoles ? await this.memberRoles.tenantId() : 1;
        const channelChatId = parsed.chatId || (isSingle ? parsed.userId : '');
        if (!channelChatId) {
          this.logger.warn(`无法解析有效 channelChatId: chatType=${parsed.chatType}, userId=${parsed.userId}`);
          return;
        }

        const member = this.memberRoles
          ? await this.memberRoles.resolve(tenantId, 'wecom_group', channelChatId, parsed.userId)
          : { role: 'CUSTOMER' as const };
        if (member.role === 'BOT') return;

        // 单聊就是对机器人说话；群聊只有真的 @ 了机器人才打 BOT 提醒标
        const mentions: string[] = [];
        if (isSingle || this.mentionsBot(parsed.content)) {
          mentions.push('BOT');
          if (this.env.WECOM_BOT_ID) mentions.push(this.env.WECOM_BOT_ID);
          const frameAibotId = (frame.body as any)?.aibotid;
          if (frameAibotId && !mentions.includes(frameAibotId)) mentions.push(frameAibotId);
        }

        const contentText = parsed.cleanedContent || parsed.content || '';
        const isTextLike = parsed.msgType === 'text' || parsed.msgType === 'voice';
        if (isTextLike && !this.checkAndRecordContent(channelChatId, parsed.userId, contentText, '长连接')) return;

        // 图片：长连接给的是加密临时链接（约 5 分钟失效），入站时立即下载解密存入共享媒体卷
        const media = parsed.msgType === 'image' ? await this.downloadImage(client, frame) : undefined;
        if (media && !this.checkAndRecordContent(channelChatId, parsed.userId, `img:${media.md5}`, '长连接图片')) return;

        const inboundMsg: InboundMessage = {
          tenantId,
          channel: 'wecom_group',
          channelChatId,
          channelMsgId: parsed.msgId,
          chatName: (parsed as any).chatName,
          sender: {
            role: member.role,
            channelUserId: parsed.userId,
          },
          mentions,
          type: (parsed.msgType === 'mixed' ? 'other' : parsed.msgType) as any,
          text: contentText,
          mediaUrl: media?.url ?? parsed.mediaInfo?.url,
          mediaMd5: media?.md5,
          sentAt: parsed.createTime || Date.now(),
        };
        await this.pipelineService.onInbound(inboundMsg);
      } catch (err: any) {
        this.logger.error(`投递核心流水线异常: ${err.message}`, err.stack);
      }
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

    // 投递核心入站流水线（全量感知、话筒抢占、客户消息汇总）
    if (this.pipelineService && event.roomid) {
      try {
        const tenantId = this.memberRoles ? await this.memberRoles.tenantId() : 1;
        const member = this.memberRoles
          ? await this.memberRoles.resolve(tenantId, 'wecom_group', event.roomid, event.sender)
          : { role: 'CUSTOMER' as const };

        if (member.role === 'BOT') return { success: true, handled: true };

        const content = event.payload?.text?.content || event.contentSummary || '';
        const cleaned = this.cleanMentionText(content);
        const isTextLike = event.msgtype === 'text' || event.msgtype === 'voice';
        if (isTextLike && !this.checkAndRecordContent(event.roomid, event.sender, cleaned || content, '会话存档')) {
          return { success: true, handled: false };
        }
        const isImage = event.msgtype === 'image';
        const imageMd5 = isImage ? (event.media?.md5 || event.payload?.image?.md5sum) : undefined;
        if (imageMd5 && !this.checkAndRecordContent(event.roomid, event.sender, `img:${imageMd5}`, '会话存档图片')) {
          return { success: true, handled: false };
        }
        const botId = this.env.WECOM_BOT_ID;

        const mentions: string[] = [];
        if (
          (this.env.WECOM_BOT_NAME && this.mentionsBot(content)) ||
          content.includes('@机器人') ||
          content.includes('@小助理') ||
          content.includes('@车和网') ||
          content.includes('@智能') ||
          content.toLowerCase().includes('@bot') ||
          content.toLowerCase().includes('@ai') ||
          (botId && content.includes(botId))
        ) {
          mentions.push('BOT');
          if (botId) mentions.push(botId);
        }

        const inboundMsg: InboundMessage = {
          tenantId,
          channel: 'wecom_group',
          channelChatId: event.roomid,
          channelMsgId: event.msgid,
          sender: {
            role: member.role,
            channelUserId: event.sender,
          },
          mentions,
          type: (event.msgtype === 'text' ? 'text' : event.msgtype === 'voice' ? 'voice' : isImage ? 'image' : 'other') as any,
          text: isImage ? '[图片]' : cleaned || content,
          mediaUrl: isImage && event.media?.key ? `${MEDIA_SCHEME}${event.media.key}` : undefined,
          mediaMd5: imageMd5,
          sentAt: event.timestamp || Date.now(),
        };

        await this.pipelineService.onInbound(inboundMsg);
      } catch (err: any) {
        this.logger.error(`会话存档投递流水线异常: ${err.message}`, err.stack);
      }
    }

    return { success: true, handled: true };
  }

  /**
   * 下载并解密长连接图片（SDK 内置 AES-256-CBC，每条消息自带 aeskey），存入共享媒体卷。
   * 未配置 MEDIA_DIR、超过大小上限或下载失败时返回 undefined，消息照常以 [图片] 占位投递。
   */
  async downloadImage(client: WSClient, frame: WsFrame<BaseMessage>): Promise<SavedMedia | undefined> {
    const image = (frame.body as any)?.image as { url?: string; aeskey?: string } | undefined;
    if (!this.env.MEDIA_DIR || !image?.url) return undefined;
    const started = Date.now();
    try {
      const { buffer } = await client.downloadFile(image.url, image.aeskey);
      if (buffer.length > (this.env.MEDIA_MAX_BYTES ?? 10 * 1024 * 1024)) {
        this.logger.warn(`图片超过大小上限（${buffer.length}B），不保存`);
        return undefined;
      }
      const saved = saveMedia(this.env.MEDIA_DIR, buffer);
      this.logger.log(`图片已保存: key=${saved.key}, ${saved.size}B, ${Date.now() - started}ms`);
      return saved;
    } catch (err: any) {
      this.logger.warn(`图片下载解密失败: ${err.message}`);
      return undefined;
    }
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
