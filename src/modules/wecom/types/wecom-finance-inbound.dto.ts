/**
 * 会话存档 Sidecar 投递给 a3 主应用的事件数据传输对象 (DTO)
 */
export interface InboundFinanceEventDto {
  /** 消息自增游标 Seq */
  seq: number;
  /** 企微消息全局唯一 ID */
  msgid: string;
  /** 是否为外部客户群 */
  isExternalRoom: boolean;
  /** 企微群聊 ID（单聊则无） */
  roomid?: string;
  /** 发送人 UserID（外部联系人以 wm/wo 开头） */
  sender: string;
  /** 消息发送时间戳 (毫秒) */
  timestamp: number;
  /** 消息类型: text / voice / image / file / mixed 等 */
  msgtype: string;
  /** 可读内容摘要 */
  contentSummary: string;
  /** 解密后的完整企微消息载荷 */
  payload: {
    msgid: string;
    action: 'send' | 'recall' | 'switch' | string;
    from: string;
    tolist: string[];
    roomid?: string;
    msgtime: number;
    msgtype: string;
    text?: { content: string };
    voice?: { play_length: number; voice_size: number; sdkfileid?: string };
    image?: { filesize: number; sdkfileid?: string; md5sum?: string };
    file?: { filename: string; filesize: number; sdkfileid?: string };
    mixed?: { item: Array<{ type: string; content: string }> };
    [key: string]: any;
  };
  /** 侧车已拉取并存入共享媒体卷的图片（key 相对 MEDIA_DIR） */
  media?: { key: string; md5: string; size: number; mime: string };
}
