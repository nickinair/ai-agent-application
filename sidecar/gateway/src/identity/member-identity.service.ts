import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { RedisService } from '../infra/redis.service';
import type {
  IdentifyMemberParams,
  IdentifyWithCacheParams,
  MemberIdentityResult,
  WecomMemberRawInfo,
} from './member-identity.types';

/**
 * 四层成员身份判定引擎（PRD §11.3）。
 * 严格区分机器人自身(BOT)、客服(STAFF_CS)、其他员工(STAFF_OTHER)、外部合作方(PARTNER)与客户(CUSTOMER)。
 * 核心保障：宁可把员工误判为客户，绝不能把客户误判为员工导致无人接待。
 */
@Injectable()
export class MemberIdentityService {
  private readonly logger = new Logger(MemberIdentityService.name);

  /** 客服人员 userid 集合 (STAFF_CS) */
  private readonly csStaffSet = new Set<string>();

  /** 协作方企业白名单集合 (PARTNER) */
  private readonly partnerCorpSet = new Set<string>();

  /** 待刷新整群集合 (追踪异步刷新触发) */
  private readonly pendingGroupRefreshes = new Set<string>();

  constructor(
    @Optional() @Inject(ENV) private readonly env?: Env,
    @Optional() private readonly redisService?: RedisService,
  ) {}

  /**
   * 动态设置/更新客服人员名单（配置驱动）
   */
  setCsStaff(staffUserIds: string[]): void {
    this.csStaffSet.clear();
    for (const id of staffUserIds) {
      if (id && id.trim()) {
        this.csStaffSet.add(id.trim());
      }
    }
  }

  /**
   * 添加单个客服人员
   */
  addCsStaff(staffUserId: string): void {
    if (staffUserId && staffUserId.trim()) {
      this.csStaffSet.add(staffUserId.trim());
    }
  }

  /**
   * 动态设置/更新协作方企业白名单（配置驱动，如 4S 店、保险公司、厂家等）
   */
  setPartnerCorpWhitelist(corpNames: string[]): void {
    this.partnerCorpSet.clear();
    for (const name of corpNames) {
      if (name && name.trim()) {
        this.partnerCorpSet.add(name.trim());
      }
    }
  }

  /**
   * 核心四层判定执行方法（PRD §11.3.1）
   */
  identify(params: IdentifyMemberParams): MemberIdentityResult {
    const {
      memberId,
      botUserId,
      rawInfo,
      manualRole,
      customCsStaffList,
      customPartnerCorpWhitelist,
    } = params;

    // 0. 第 ⓪ 优先级：人工干预最高（运营改角色优先级最高，后续同步不覆盖）
    if (manualRole) {
      this.logger.debug(`[身份判定] 命中运营人工设置角色: memberId=${memberId}, role=${manualRole}`);
      return {
        memberId,
        role: manualRole,
        source: 'MANUAL',
        name: rawInfo?.name,
        corpName: rawInfo?.corpName,
        rawType: rawInfo?.type,
      };
    }

    // 1. 第一层：机器人自身识别（发送人 ID = bot_user_id -> BOT，直接忽略）
    if (botUserId && memberId === botUserId) {
      return {
        memberId,
        role: 'BOT',
        source: 'BOT',
        name: rawInfo?.name,
        corpName: rawInfo?.corpName,
        rawType: rawInfo?.type,
      };
    }

    // 2. 第二层：权威渠道身份（企微官方群详情接口返回的成员类型：1 = 本企业成员，2 = 外部联系人）
    if (rawInfo && rawInfo.type !== undefined) {
      // 2.1 type === 1：本企业成员 -> 进入第四层业务角色配置划分
      if (rawInfo.type === 1) {
        const isCs = this.isCsStaff(memberId, customCsStaffList);
        if (isCs) {
          return {
            memberId,
            role: 'STAFF_CS',
            source: 'INTERNAL_CS',
            name: rawInfo.name,
            rawType: 1,
          };
        } else {
          // 附录 C 用例 S21 核心判定：群内销售（本企业成员，不在客服配置中）发言 -> STAFF_OTHER
          return {
            memberId,
            role: 'STAFF_OTHER',
            source: 'INTERNAL_OTHER',
            name: rawInfo.name,
            rawType: 1,
          };
        }
      }

      // 2.2 type === 2：外部联系人 -> 进入第三层外部联系人细分
      if (rawInfo.type === 2) {
        // 3.1 微信个人用户（非企业微信） -> 客户 CUSTOMER
        if (rawInfo.externalType === 1) {
          return {
            memberId,
            role: 'CUSTOMER',
            source: 'EXTERNAL_WECHAT',
            name: rawInfo.name,
            rawType: 2,
          };
        }

        // 3.2 企业微信外部联系人（带所属企业名）
        if (rawInfo.externalType === 2) {
          const corp = rawInfo.corpName?.trim() || '';
          const isPartner = this.isPartnerCorp(corp, customPartnerCorpWhitelist);
          if (isPartner) {
            return {
              memberId,
              role: 'PARTNER',
              source: 'EXTERNAL_PARTNER',
              name: rawInfo.name,
              corpName: corp,
              rawType: 2,
            };
          } else {
            return {
              memberId,
              role: 'CUSTOMER',
              source: 'EXTERNAL_CUSTOMER',
              name: rawInfo.name,
              corpName: corp,
              rawType: 2,
            };
          }
        }

        // 兜底外部联系人
        return {
          memberId,
          role: 'CUSTOMER',
          source: 'EXTERNAL_CUSTOMER',
          name: rawInfo.name,
          rawType: 2,
        };
      }
    }

    // 3. 兜底规则（PRD §11.3.1 兜底）
    // 3.1 成员信息查询失败或未拉取到详情时，按企微 ID 格式粗判（外部联系人通常为 wm-xxx 或 wo-xxx）
    if (/^(wm|wo)/i.test(memberId)) {
      return {
        memberId,
        role: 'CUSTOMER',
        source: 'FALLBACK',
      };
    }

    // 3.2 仍判不出则一律按 CUSTOMER 兜底，并打告警日志由运营人工改角色确认
    this.logger.warn(`[身份判定告警] 成员信息缺失或无法识别，降级兜底为 CUSTOMER: memberId=${memberId}`);
    return {
      memberId,
      role: 'CUSTOMER',
      source: 'FALLBACK',
    };
  }

  /**
   * 带 Redis 缓存与 300ms 强制超时熔断的身份识别（PRD §11.3.3、附录 C 用例 S23）
   */
  async identifyWithCache(params: IdentifyWithCacheParams): Promise<MemberIdentityResult> {
    const {
      tenantId,
      channelChatId,
      memberId,
      fetcher,
      skipCache = false,
    } = params;

    // 1. 缓存优先判定：读取 Redis Hash（ag:chat:members:{tenantId}:{chatId}），时延 ≤ 1ms
    if (!skipCache && channelChatId && this.redisService) {
      const cacheKey = this.buildCacheKey(tenantId, channelChatId);
      const cachedStr = await this.redisService.hget(cacheKey, memberId);
      if (cachedStr) {
        try {
          const cachedResult = JSON.parse(cachedStr) as MemberIdentityResult;
          this.logger.debug(
            `[身份缓存命中] chatId=${channelChatId}, memberId=${memberId}, role=${cachedResult.role}`,
          );
          return cachedResult;
        } catch {
          // 缓存数据异常时忽略，继续实时判定
        }
      }
    }

    // 2. 缓存未命中：若未传 rawInfo 但提供了外部拉取器 fetcher，执行 300ms 强制超时熔断
    let rawInfo: WecomMemberRawInfo | undefined = params.rawInfo;
    if (!rawInfo && fetcher) {
      const timeoutMs = this.env?.IDENTITY_FETCH_TIMEOUT_MS ?? 300;
      try {
        rawInfo =
          (await Promise.race([
            fetcher(),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error(`成员详情同步查询超时（超过 ${timeoutMs}ms）`)),
                timeoutMs,
              ),
            ),
          ])) ?? undefined;
      } catch (err: unknown) {
        // 3. 核心验收用例 S23（铁律）：新成员入群立即发言且查询超时/异常，按兜底规则判为 CUSTOMER 并正常回复，标记 FALLBACK 并告警
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `[S23 告警] 新成员入群立即发言且详情查询超时/异常，触发兜底降级: memberId=${memberId}, reason=${reason}`,
        );

        const fallbackResult: MemberIdentityResult = {
          memberId,
          role: 'CUSTOMER',
          source: 'FALLBACK',
        };

        // 异步触发整群刷新
        if (channelChatId) {
          this.triggerAsyncGroupRefresh(tenantId, channelChatId);
        }

        return fallbackResult;
      }
    }

    // 4. 执行标准四层判定
    const result = this.identify({ ...params, rawInfo });

    // 5. 判定结果写入 Redis 缓存并设置 1 小时 TTL
    if (this.redisService && channelChatId) {
      const cacheKey = this.buildCacheKey(tenantId, channelChatId);
      const ttlSeconds = this.env?.IDENTITY_CACHE_TTL_SECONDS ?? 3600;
      await this.redisService.hset(cacheKey, memberId, JSON.stringify(result));
      await this.redisService.expire(cacheKey, ttlSeconds);
    }

    return result;
  }

  /**
   * 生成群成员身份 Redis Key（PRD §7.1）
   */
  buildCacheKey(tenantId: number, channelChatId: string): string {
    return `ag:chat:members:${tenantId}:${channelChatId}`;
  }

  /**
   * 触发异步整群成员刷新调度（PRD §11.3.3 兜底刷新）
   */
  triggerAsyncGroupRefresh(tenantId: number, channelChatId: string): void {
    const groupKey = `${tenantId}:${channelChatId}`;
    this.pendingGroupRefreshes.add(groupKey);
    this.logger.log(`[异步整群刷新] 调度后台增量刷新任务: tenantId=${tenantId}, chatId=${channelChatId}`);
  }

  /**
   * 获取待刷新的群列表（供单测与调度任务使用）
   */
  getPendingGroupRefreshes(): ReadonlySet<string> {
    return this.pendingGroupRefreshes;
  }

  /**
   * 清空待刷新的群列表（供单测生命周期使用）
   */
  clearPendingGroupRefreshes(): void {
    this.pendingGroupRefreshes.clear();
  }

  /**
   * 判断是否为客服人员
   */
  private isCsStaff(memberId: string, customList?: string[]): boolean {
    if (customList && customList.length > 0) {
      return customList.includes(memberId);
    }
    return this.csStaffSet.has(memberId);
  }

  /**
   * 判断所属企业是否在协作方企业白名单中
   */
  private isPartnerCorp(corpName: string, customList?: string[]): boolean {
    if (!corpName) return false;
    if (customList && customList.length > 0) {
      return customList.some((whitelistItem) => corpName.includes(whitelistItem));
    }
    for (const item of this.partnerCorpSet) {
      if (corpName.includes(item)) {
        return true;
      }
    }
    return false;
  }
}
