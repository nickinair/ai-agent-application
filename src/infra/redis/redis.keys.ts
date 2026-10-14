/**
 * @file redis.keys.ts
 * @description 智能体全能平台核心 Redis Key 命名规范常量
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §7.1 Redis Key 设计
 */

export const REDIS_KEYS = {
  /**
   * 未封组消息 ID 列表（按到达顺序，List）
   * @param convId 会话 ID
   * @param senderId 发送人在渠道内的用户 ID
   */
  buffer: (convId: number | string, senderId: string) =>
    `ag:buf:${convId}:${senderId}`,

  /**
   * 缓冲池元数据（Hash: firstAt, lastAt, count, version, epoch）
   * @param convId 会话 ID
   * @param senderId 发送人在渠道内的用户 ID
   */
  bufferMeta: (convId: number | string, senderId: string) =>
    `ag:bufmeta:${convId}:${senderId}`,

  /**
   * 会话发言权话筒状态（Hash，§6.2）
   * @param convId 会话 ID
   */
  mic: (convId: number | string) => `ag:mic:${convId}`,

  /**
   * 会话处理排他锁（String，SET NX PX 10000）
   * @param convId 会话 ID
   */
  convLock: (convId: number | string) => `ag:lock:conv:${convId}`,

  /**
   * 在途执行组（Hash: groupId, sealedAt, turnId）
   * @param convId 会话 ID
   */
  inflight: (convId: number | string) => `ag:inflight:${convId}`,

  /**
   * 会话级背景 JSON 缓存（String）
   * @param convId 会话 ID
   */
  background: (convId: number | string) => `ag:bg:${convId}`,

  /**
   * 活跃会话映射（String: 群聊 -> 活跃会话 ID）
   * @param tenantId 租户 ID
   * @param channelChatId 群 ID
   */
  activeConv: (tenantId: number | string, channelChatId: string) =>
    `ag:conv:active:${tenantId}:${channelChatId}`,

  /**
   * 已发布规则包快照（String）
   * @param tenantId 租户 ID
   * @param rulePackVersion 规则包版本号
   */
  rulePackConfig: (tenantId: number | string, rulePackVersion: string) =>
    `ag:cfg:${tenantId}:${rulePackVersion}`,

  /**
   * 群成员角色映射缓存（Hash: memberId -> role，§11.3）
   * @param tenantId 租户 ID
   * @param chatId 群 ID
   */
  chatMembers: (tenantId: number | string, chatId: string) =>
    `ag:chat:members:${tenantId}:${chatId}`,
} as const;
