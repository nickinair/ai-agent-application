/**
 * @file message.ts
 * @description 智能体全能平台统一消息契约（入站消息、出站消息与组内消息引用）
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §5.2、§5.3、§6.3、§11.3
 */

import type { ChannelType, MemberRole, MessageType } from './enums';

/**
 * 消息发送人身份详情
 * 
 * 业务背景：
 * - 详见方案 §11.3。群聊环境下，发送人身份直接决定消息流向：
 *   - role 为 CUSTOMER 时，消息进入聚合缓冲池并触发机器人问答流程；
 *   - role 为内部员工时，若非 @机器人 则判定为人工发言，触发话筒抢夺与 AI 在途答案作废。
 */
export interface MessageSender {
  /**
   * 发送人在当前业务场景下的识别角色
   * 由身份识别模块根据群属性、通讯录及成员标记动态解析判定
   */
  role: MemberRole;

  /**
   * 发送人在渠道内的原生唯一用户 ID
   * 业务特征：企微外部联系人（客户）通常以 'wm' 或 'wo' 开头；内部员工通常为企业通信录成员 userid
   */
  channelUserId: string;

  /**
   * 发送人渠道群内显示昵称或备注名
   * 业务边界：可选字段；注意群昵称可能与 CRM 系统登记的真实客户姓名不一致
   */
  name?: string;
}

/**
 * 渠道无关的统一入站消息（接入网关层产物，§5.2）
 * 
 * 业务流转：
 * - 网关（ai-agent-gateway）或会话存档 Sidecar 接收到渠道原生推送后，规范化转换为此对象；
 * - 经 MQ（路由键: inbound.message）投递给智能体核心应用（ai-agent-application）处理。
 */
export interface InboundMessage {
  /**
   * 租户唯一标识
   * 业务边界：平台预留全局模板与系统级参数使用 tenantId = 0；企业实际接入租户必须为严格正整数（> 0）
   */
  tenantId: number;

  /**
   * 消息来源渠道类型
   * 业务边界：生产环境主要为企微群聊或单聊；测试注入使用 test
   */
  channel: ChannelType;

  /**
   * 渠道原生的群 ID 或单聊会话 ID
   * 业务特征：企微外部客户群通常以 'wr' 前缀开头，单聊由两端用户标识唯一确定
   */
  channelChatId: string;

  /**
   * 渠道侧消息全局唯一 ID
   * 业务边界：存储与网关接入层的**唯一索引与幂等去重依据**。若接收到已处理过的 channelMsgId，系统直接静默丢弃
   */
  channelMsgId: string;

  /**
   * 渠道群聊名称
   * 业务边界：单聊会话时为 undefined；外部群需匹配规则包群名正则以提取客户姓名、手机号、车型与购车状态
   */
  chatName?: string;

  /**
   * 消息发送人身份信息（角色、渠道用户 ID、昵称）
   */
  sender: MessageSender;

  /**
   * 消息中被显式 @ 的渠道用户 ID 列表
   * 业务边界：若未 @ 任何人员则为空数组；用于判断人工是否主动 @机器人 移交话筒或客户 @客服
   */
  mentions: string[];

  /**
   * 消息的物理内容类型
   * 业务边界：文本 / 语音（企微已转写）直接理解；图片由核心服务「看图」转成文字描述后并入组文本
   */
  type: MessageType;

  /**
   * 消息正文文本内容
   * 业务边界：文本消息为客户输入原文；图片消息在封组前落库原样记录，封组拼接时以 [图片] 占位
   */
  text?: string;

  /**
   * 富媒体文件的存放位置
   * 业务边界：纯文本消息为 undefined；图片在入站时已下载解密并存入共享媒体卷，记为 media://{key}
   * （key 相对 MEDIA_DIR），核心服务据此读图看图；未能转存时可能是渠道临时链接或为空
   */
  mediaUrl?: string;

  /**
   * 媒体文件 MD5（小写 hex）
   * 业务边界：跨通道图片去重、看图结果缓存的键；未转存时为 undefined
   */
  mediaMd5?: string;

  /**
   * 渠道侧记录的消息生成时间戳（毫秒）
   * 业务边界：作为封组缓冲池的升序排序基准，以及 3 秒静默超时窗口的起始参照
   */
  sentAt: number;
}

/**
 * 出站消息类别元数据常量字典
 * 
 * Key 是唯一的标识符字符串字面量，Value 是该类型的自述元数据（包含标签、描述及专用控制属性）
 */
export const OUTBOUND_MESSAGE_KIND = {
  /** 正式问答回复，推送到群聊或单聊 */
  REPLY: {
    label: '正式回复',
    desc: '正式问答回复，推送到群聊或单聊',
    isPrivateOnly: false,
  },
  /** 首轮超过 0.5s 未完成组织时输出的占位安抚话术 */
  PLACEHOLDER: {
    label: '占位安抚',
    desc: '首轮超过 0.5s 未完成组织时输出的占位安抚话术（如“正在为您查询…”）',
    isPrivateOnly: false,
  },
  /** 转人工通知，在群内 @客服人员 提示接管 */
  HANDOFF_NOTICE: {
    label: '转人工通知',
    desc: '转人工通知，在群内 @客服人员 提示接管',
    isPrivateOnly: false,
  },
  /** 客户完整交接上下文包，私信定向推送给指定接管客服，严禁发在公开群内（§6.3） */
  HANDOFF_PACKAGE: {
    label: '客服交接包',
    desc: '客户完整交接上下文包，私信定向推送给指定接管客服，严禁发在公开群内（§6.3）',
    isPrivateOnly: true,
  },
} as const;

/**
 * 出站消息类别联合类型
 * 
 * @see OUTBOUND_MESSAGE_KIND
 * 最终推导结果: 'REPLY' | 'PLACEHOLDER' | 'HANDOFF_NOTICE' | 'HANDOFF_PACKAGE'
 */
export type OutboundMessageKind = keyof typeof OUTBOUND_MESSAGE_KIND;

/**
 * 渠道无关的统一出站消息（核心应用产物，§5.2）
 * 
 * 业务流转：
 * - 核心应用（Core / a3）在完成回答组织或转人工决策后生成；
 * - 经 MQ（路由键: outbound.message）投递给接入网关，由网关适配各渠道 API 完成最终发送。
 */
export interface OutboundMessage {
  /**
   * 所属企业租户 ID（业务范围: > 0）
   */
  tenantId: number;

  /**
   * 目标发送渠道类型
   */
  channel: ChannelType;

  /**
   * 发送目标的渠道群 ID 或单聊会话 ID
   */
  channelChatId: string;

  /**
   * 出站消息业务类别
   */
  kind: OutboundMessageKind;

  /**
   * 准备发出的文本正文
   * 业务边界：不得包含暴露 AI 身份的禁忌词（如“作为机器人”）；单条回复有字符长度上限控制（默认 300 字）
   */
  text: string;

  /**
   * 发送回复时需要在渠道侧显式 @ 的成员 channelUserId 列表
   * 业务边界：转人工场景下用于强提醒指定专属客服
   */
  mentions?: string[];

  /**
   * 定向私信接收人 channelUserId
   * 业务边界：仅当 kind 为 HANDOFF_PACKAGE 时必填；该内容直接私发给对应客服，不得在公开客户群展示
   */
  toUserId?: string;

  /**
   * 关联的数据库会话主键 ID（可选，用于数据追踪与日志审计）
   */
  conversationId?: number;

  /**
   * 关联的数据库问答轮次主键 ID（可选，用于数据追踪与时延考核）
   */
  turnId?: number;
}

/**
 * 聚合消息组内对单条消息的结构化轻量引用
 * 
 * 业务背景：
 * - 详见方案 §5.2。封组后进入流水线时，组内包含 1 至多条用户消息明细；
 * - 用于在末检追溯、日志审计及组内按时序展示对话脉络。
 */
export interface MessageRef {
  /**
   * 消息在数据库 message 表中的主键自增 ID
   */
  messageId: number;

  /**
   * 渠道原生唯一消息 ID（用于快速幂等核对）
   */
  channelMsgId: string;

  /**
   * 发送人身份角色
   */
  senderRole: MemberRole;

  /**
   * 消息文本或媒体占位内容
   */
  text?: string;

  /**
   * 渠道发送时间戳（毫秒）
   */
  sentAt: number;

  /**
   * 消息类型（text / image / voice ...），核心服务按此找出组内图片
   */
  msgType?: string;

  /**
   * 媒体存放位置（media://{key}，见 InboundMessage.mediaUrl）
   */
  mediaUrl?: string | null;
}
