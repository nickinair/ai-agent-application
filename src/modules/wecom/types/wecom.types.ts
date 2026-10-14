import type { BaseMessage, WsFrame } from '@wecom/aibot-node-sdk';

/** 统一解析后的企业微信接收消息结构（覆盖官方文档 101834） */
export interface WecomIncomingMessage {
  /** 消息唯一 ID（用于防重排重） */
  msgId: string;
  /** 会话类型：group 群聊，single 单聊 */
  chatType: 'group' | 'single' | string;
  /** 群聊 ID（仅群聊时有效） */
  chatId: string;
  /** 发送者的企微 UserID */
  userId: string;
  /** 消息类型：text / voice / image / file / video / mixed 等 */
  msgType: string;
  /** 消息文本内容（文本消息内容或语音自动转写文本） */
  content: string;
  /** 清洗去除 @ 机器人后的有效纯文本内容 */
  cleanedContent: string;
  /** 是否需要触发转人工处理（非文本、语音的多媒体消息为 true） */
  requiresHumanHandoff: boolean;
  /** 多媒体资源摘要（图片/文件/视频等） */
  mediaInfo?: {
    url?: string;
    hasAesKey?: boolean;
    mixedItemCount?: number;
  };
  /** 被引用消息摘要（若存在） */
  quote?: {
    msgType: string;
    text?: string;
  };
  /** 消息产生时间戳 */
  createTime?: number;
  /** 底层收到的原始 WebSocket 数据帧 */
  rawFrame: WsFrame<BaseMessage>;
}

/** 兼容旧版命名的群聊文本/语音消息别名 */
export type WecomGroupTextMessage = WecomIncomingMessage;

/** 机器人长连接与运行指标状态 */
export interface WecomBotStatus {
  /** 是否已配置凭证 (Bot ID & Secret) */
  configured: boolean;
  /** 是否启用 */
  enabled: boolean;
  /** WebSocket 底层是否已连接 */
  connected: boolean;
  /** WebSocket 是否认证成功 */
  authenticated: boolean;
  /** 当前运行的 Bot ID（脱敏展示） */
  botId: string | null;
  /** 统计数据 */
  stats: {
    /** 累计接收到的消息总数 */
    totalMessagesReceived: number;
    /** 累计回复消息数 */
    totalRepliesSent: number;
    /** 累计转人工次数 */
    totalHandoffCount: number;
    /** 最近一次接收消息时间 */
    lastMessageAt: string | null;
    /** 最近一次鉴权成功时间 */
    lastAuthenticatedAt: string | null;
  };
}

/** 消息处理中间件/监听器钩子接口，方便后续业务模型或 Agent 引擎挂载 */
export type WecomGroupMessageHandler = (msg: WecomIncomingMessage) => Promise<string | void>;
