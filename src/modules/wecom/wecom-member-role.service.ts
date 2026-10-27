/**
 * @file wecom-member-role.service.ts
 * @description 企微群消息的租户与发送人角色识别（方案 §11.3.1 四层识别，与核心服务 members/member-role.ts 同一规则）。
 *
 * 优先级：
 *   ① 运营人工设置（chat_member.role_source = MANUAL）
 *   ② 机器人自身（channel_account.bot_user_id 或 WECOM_BOT_ID）→ BOT
 *   ③ 群成员同步已识别过的（chat_member.role_source = CHANNEL / CONFIG，如会话存档、群详情同步写入）
 *   ④ 客服配置（cs_staff）→ STAFF_CS
 *   ⑤ 企微 ID 规则：外部联系人 ID 以 wm（微信用户）/ wo（企业微信用户）开头 → CUSTOMER；其余为本企业成员 → STAFF_OTHER
 * 协作方（PARTNER）需要外部企业名，智能机器人消息里没有，只能靠 ③（群详情同步）或 ①（人工）识别。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { RowDataPacket } from 'mysql2/promise';
import { ENV, type Env } from '../../config/env';
import { MysqlService } from '../../database/mysql.service';
import type { MemberRole } from '../../contracts';

const CACHE_MS = 60_000;
const EXTERNAL_ID = /^w[mo][A-Za-z0-9_-]{6,}$/;

export type RoleSource = 'MANUAL' | 'CONFIG' | 'CHANNEL' | 'FALLBACK';
export interface ResolvedMember {
  role: MemberRole;
  source: RoleSource;
}

interface TenantConfig {
  botIds: Set<string>;
  csStaffIds: Set<string>;
  at: number;
}

/** 按企微 ID 规则判断渠道身份 */
export function memberTypeOf(memberId: string): 'INTERNAL' | 'EXTERNAL_WECHAT' | 'EXTERNAL_WECOM' {
  if (!EXTERNAL_ID.test(memberId)) return 'INTERNAL';
  return memberId.startsWith('wm') ? 'EXTERNAL_WECHAT' : 'EXTERNAL_WECOM';
}

@Injectable()
export class WecomMemberRoleService {
  private readonly logger = new Logger(WecomMemberRoleService.name);
  private tenantCache?: { tenantId: number; at: number };
  private readonly configs = new Map<number, TenantConfig>();

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly mysql: MysqlService,
  ) {}

  /** 本机器人所属租户：channel_account 里登记的机器人账号优先，没登记时用 WECOM_TENANT_ID（默认 1） */
  async tenantId(): Promise<number> {
    if (this.tenantCache && Date.now() - this.tenantCache.at < CACHE_MS) return this.tenantCache.tenantId;
    let tenantId = this.env.WECOM_TENANT_ID ?? 1;
    if (this.env.WECOM_BOT_ID) {
      const [rows] = await this.mysql.getPool().query<RowDataPacket[]>(
        `SELECT tenant_id FROM channel_account WHERE bot_user_id = ? AND status = 1 ORDER BY id LIMIT 1`,
        [this.env.WECOM_BOT_ID],
      );
      if (rows[0]) tenantId = Number(rows[0].tenant_id);
    }
    this.tenantCache = { tenantId, at: Date.now() };
    return tenantId;
  }

  async resolve(tenantId: number, channel: string, chatId: string, memberId: string, name?: string): Promise<ResolvedMember> {
    const pool = this.mysql.getPool();
    const [known] = await pool.query<RowDataPacket[]>(
      `SELECT role, role_source FROM chat_member WHERE tenant_id = ? AND channel_chat_id = ? AND member_id = ?`,
      [tenantId, chatId, memberId],
    );
    const row = known[0];
    if (row?.role_source === 'MANUAL') return { role: row.role, source: 'MANUAL' };

    const cfg = await this.config(tenantId);
    if (cfg.botIds.has(memberId)) return { role: 'BOT', source: 'CONFIG' };
    if (row && (row.role_source === 'CHANNEL' || row.role_source === 'CONFIG')) return { role: row.role, source: row.role_source };

    const memberType = memberTypeOf(memberId);
    const r: ResolvedMember = cfg.csStaffIds.has(memberId)
      ? { role: 'STAFF_CS', source: 'CONFIG' }
      : memberType === 'INTERNAL'
        ? { role: 'STAFF_OTHER', source: 'CHANNEL' }
        : { role: 'CUSTOMER', source: 'CHANNEL' };

    await pool
      .query(
        `INSERT INTO chat_member (tenant_id, channel, channel_chat_id, member_id, name, member_type, role, role_source, joined_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE name = COALESCE(VALUES(name), name), member_type = VALUES(member_type), role = VALUES(role), role_source = VALUES(role_source)`,
        [tenantId, channel, chatId, memberId, name ?? null, memberType, r.role, r.source],
      )
      .catch((err: Error) => this.logger.warn(`写群成员身份失败 ${chatId}/${memberId}：${err.message}`));
    return r;
  }

  private async config(tenantId: number): Promise<TenantConfig> {
    const hit = this.configs.get(tenantId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit;
    const pool = this.mysql.getPool();
    const [[bots], [staff]] = await Promise.all([
      pool.query<RowDataPacket[]>(`SELECT bot_user_id FROM channel_account WHERE tenant_id = ? AND status = 1`, [tenantId]),
      pool.query<RowDataPacket[]>(`SELECT wecom_user_id FROM cs_staff WHERE tenant_id = ? AND status = 1`, [tenantId]),
    ]);
    const botIds = new Set<string>(bots.map((b) => String(b.bot_user_id)));
    if (this.env.WECOM_BOT_ID) botIds.add(this.env.WECOM_BOT_ID);
    // RPA 代发账号（真人企微账号模拟发送）：它发出的消息由会话存档收回时按机器人处理，避免被当成员工抢话筒
    for (const id of (process.env.WECOM_RPA_BOT_USER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) botIds.add(id);
    const cfg = { botIds, csStaffIds: new Set<string>(staff.map((s) => String(s.wecom_user_id))), at: Date.now() };
    this.configs.set(tenantId, cfg);
    return cfg;
  }
}
