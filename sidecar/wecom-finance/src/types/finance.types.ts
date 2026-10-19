/**
 * 企业微信会话内容存档 (Finance SDK) 协议与数据结构类型定义
 * 参考官方文档: https://developer.work.weixin.qq.com/document/path/91774
 */

/**
 * 企微原始加密记录项
 */
export interface EncryptedChatData {
  /** 消息序号（自增游标） */
  seq: number;
  /** 消息唯一标识 */
  msgid: string;
  /** 公钥版本号，用于多密钥轮转 */
  publickey_ver: number;
  /** 经企业 RSA 公钥加密后的 16 字节随机 AES Key（Base64） */
  encrypt_random_key: string;
  /** 经随机 AES Key (AES-256-CBC) 加密后的聊天记录明文 JSON（Base64） */
  encrypt_chat_msg: string;
}

/**
 * 企微 SDK GetChatData 拉取原始响应结构
 */
export interface FinanceChatDataResponse {
  errcode: number;
  errmsg: string;
  chatdata: EncryptedChatData[];
}

/**
 * 解密后基础消息公共字段
 */
export interface BaseDecryptedMessage {
  /** 消息唯一ID */
  msgid: string;
  /** 消息动作: send(发送), recall(撤回), switch(切换企业) */
  action: 'send' | 'recall' | 'switch';
  /** 发送方 userid 或外部联系人 id (以 wm/wo 开头) */
  from: string;
  /** 接收方列表 (如果是群聊，包含群成员或者为群房间) */
  tolist: string[];
  /** 群聊 ID。若为单聊则为空或不存在；外部群通常以 wr 开头或为包含外部成员的房间 */
  roomid?: string;
  /** 消息发送时间戳 (毫秒或秒) */
  msgtime: number;
  /** 消息类型 */
  msgtype: string;
}

/**
 * 文本消息
 */
export interface TextMessage extends BaseDecryptedMessage {
  msgtype: 'text';
  text: {
    content: string;
  };
}

/**
 * 语音消息
 */
export interface VoiceMessage extends BaseDecryptedMessage {
  msgtype: 'voice';
  voice: {
    voice_size: number;
    play_length: number;
    sdkfileid: string;
    md5sum: string;
  };
}

/**
 * 图片消息
 */
export interface ImageMessage extends BaseDecryptedMessage {
  msgtype: 'image';
  image: {
    filesize: number;
    sdkfileid: string;
    md5sum: string;
  };
}

/**
 * 视频消息
 */
export interface VideoMessage extends BaseDecryptedMessage {
  msgtype: 'video';
  video: {
    filesize: number;
    play_length: number;
    sdkfileid: string;
    md5sum: string;
  };
}

/**
 * 文件消息
 */
export interface FileMessage extends BaseDecryptedMessage {
  msgtype: 'file';
  file: {
    filename: string;
    fileext: string;
    filesize: number;
    sdkfileid: string;
    md5sum: string;
  };
}

/**
 * 图文链接消息
 */
export interface LinkMessage extends BaseDecryptedMessage {
  msgtype: 'link';
  link: {
    title: string;
    description: string;
    link_url: string;
    image_url: string;
  };
}

/**
 * 混合混排消息
 */
export interface MixedMessageItem {
  type: 'text' | 'image';
  content: string;
}

export interface MixedMessage extends BaseDecryptedMessage {
  msgtype: 'mixed';
  mixed: {
    item: MixedMessageItem[];
  };
}

/**
 * 撤回动作消息
 */
export interface RevokeMessage extends BaseDecryptedMessage {
  action: 'recall';
  revoke: {
    pre_msgid: string;
  };
}

/**
 * 所有解密后消息的联合类型
 */
export type DecryptedFinanceMessage =
  | TextMessage
  | VoiceMessage
  | ImageMessage
  | VideoMessage
  | FileMessage
  | LinkMessage
  | MixedMessage
  | (BaseDecryptedMessage & Record<string, any>);

/**
 * 派发给下游网关/缓冲池的规范化事件
 */
export interface InboundFinanceEvent {
  seq: number;
  msgid: string;
  isExternalRoom: boolean;
  roomid?: string;
  sender: string;
  timestamp: number;
  msgtype: string;
  contentSummary: string;
  payload: DecryptedFinanceMessage;
}

/**
 * Sidecar 全局配置接口
 */
export interface FinanceSidecarConfig {
  corpid: string;
  secret: string;
  driverMode: 'mock' | 'native';
  rsaPrivateKey: string;
  rsaPrivateKeyPassphrase?: string;
  pollIntervalMs: number;
  batchSize: number;
  cursorStoragePath: string;
  cSdkLibPath?: string;
  a3WebhookUrl?: string;
  a3WebhookSecret?: string;
  gatewayUrl?: string;
  gatewayEnabled?: boolean;
  gatewayServiceName?: string;
  gatewayA3ServiceName?: string;
  gatewayNamespace?: string;
  gatewayHeartbeatIntervalMs?: number;
  gatewayAuthToken?: string;
}
