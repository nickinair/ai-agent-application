/**
 * 成员角色类型定义（方案 §11.3）
 */
export type MemberRole = 'BOT' | 'CUSTOMER' | 'STAFF_CS' | 'STAFF_OTHER' | 'PARTNER';

/**
 * 企微官方接口返回的群成员原始详情结构（PRD §11.1、§11.3）
 */
export interface WecomMemberRawInfo {
  userid: string;
  name?: string;
  /**
   * 成员类型：1 = 本企业成员，2 = 外部联系人
   */
  type?: number;
  /**
   * 外部联系人类型：1 = 微信用户，2 = 企业微信用户
   */
  externalType?: number;
  /**
   * 外部联系人所属企业简称/全称（当 externalType = 2 时有效）
   */
  corpName?: string;
  unionid?: string;
}

/**
 * 身份识别决策来源标识
 */
export type IdentityDecisionSource =
  | 'MANUAL'
  | 'BOT'
  | 'INTERNAL_CS'
  | 'INTERNAL_OTHER'
  | 'EXTERNAL_WECHAT'
  | 'EXTERNAL_PARTNER'
  | 'EXTERNAL_CUSTOMER'
  | 'FALLBACK';

/**
 * 成员身份识别入参
 */
export interface IdentifyMemberParams {
  tenantId: number;
  channelChatId?: string;
  memberId: string;
  /** 可选：群机器人 ID（若不传则使用系统配置的默认机器人 ID） */
  botUserId?: string;
  /** 企微原始成员信息 */
  rawInfo?: WecomMemberRawInfo;
  /** 运营后台人工设定的角色（最高优先级，不被后续覆盖） */
  manualRole?: MemberRole;
  /** 可选覆盖的客服名单与合作企业白名单 */
  customCsStaffList?: string[];
  customPartnerCorpWhitelist?: string[];
}

/**
 * 带缓存的成员身份识别入参
 */
export interface IdentifyWithCacheParams extends IdentifyMemberParams {
  /** 外部接口成员详情异步拉取函数（当缓存未命中时调用） */
  fetcher?: () => Promise<WecomMemberRawInfo | undefined | null>;
  /** 强制跳过缓存（默认 false） */
  skipCache?: boolean;
}

/**
 * 成员身份判定结果
 */
export interface MemberIdentityResult {
  memberId: string;
  role: MemberRole;
  source: IdentityDecisionSource;
  name?: string;
  corpName?: string;
  rawType?: number;
}
