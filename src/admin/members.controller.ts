import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { Roles, Tenant, TenantContext } from '../auth/tenant-context';
import { MysqlService } from '../database/mysql.service';
import { ConfigNotifier } from '../infra/config-notifier';
import { parse } from './validation';

const WRITERS = ['platform_admin', 'tenant_admin', 'operator'] as const;

/** 群成员身份（§11.3）：查看、人工修正角色 / 主客户；协作方企业白名单 */
@Controller()
export class MembersController {
  constructor(
    private readonly mysql: MysqlService,
    private readonly notifier: ConfigNotifier,
  ) {}

  @Get('chats/:chatId/members')
  async members(@Tenant() t: TenantContext, @Param('chatId') chatId: string) {
    return this.mysql.query(
      `SELECT member_id AS memberId, name, member_type AS memberType, corp_name AS corpName, role, role_source AS roleSource, is_primary AS isPrimary, joined_at AS joinedAt, left_at AS leftAt
         FROM chat_member WHERE tenant_id = ? AND channel_chat_id = ? ORDER BY left_at IS NOT NULL, role, member_id`,
      [t.tenantId, chatId],
    );
  }

  /** 人工改角色或设主客户；人工设置的角色（MANUAL）之后的同步不会覆盖 */
  @Patch('chats/:chatId/members/:memberId')
  @Roles(...WRITERS)
  async patchMember(@Tenant() t: TenantContext, @Param('chatId') chatId: string, @Param('memberId') memberId: string, @Body() body: unknown) {
    const b = parse(
      z.object({ role: z.enum(['CUSTOMER', 'STAFF_CS', 'STAFF_OTHER', 'PARTNER']).optional(), isPrimary: z.boolean().optional() }).refine((v) => v.role || v.isPrimary !== undefined, '至少修改 role 或 isPrimary'),
      body,
    );
    const sets: string[] = [];
    const args: unknown[] = [];
    if (b.role) sets.push(`role = ?, role_source = 'MANUAL'`), args.push(b.role);
    if (b.isPrimary !== undefined) sets.push('is_primary = ?'), args.push(b.isPrimary ? 1 : 0);
    const r = await this.mysql.execute(`UPDATE chat_member SET ${sets.join(', ')} WHERE tenant_id = ? AND channel_chat_id = ? AND member_id = ?`, [...args, t.tenantId, chatId, memberId]);
    if (r.affectedRows === 0) throw new NotFoundException('群成员不存在');
    // 一个群只有一个主客户
    if (b.isPrimary) await this.mysql.execute('UPDATE chat_member SET is_primary = 0 WHERE tenant_id = ? AND channel_chat_id = ? AND member_id <> ?', [t.tenantId, chatId, memberId]);
    await this.notifier.notify(t.tenantId, 'member');
    return { chatId, memberId, ...b };
  }

  @Get('partner-corps')
  async partners(@Tenant() t: TenantContext) {
    return this.mysql.query('SELECT id, corp_name AS corpName, status FROM partner_corp WHERE tenant_id = ? ORDER BY corp_name', [t.tenantId]);
  }

  @Post('partner-corps')
  @Roles(...WRITERS)
  async addPartner(@Tenant() t: TenantContext, @Body() body: unknown) {
    const b = parse(z.object({ corpName: z.string().trim().min(1).max(128) }), body);
    await this.mysql.execute('INSERT INTO partner_corp (tenant_id, corp_name, status) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE status = 1', [t.tenantId, b.corpName]);
    await this.notifier.notify(t.tenantId, 'member');
    return { corpName: b.corpName };
  }

  @Delete('partner-corps/:id')
  @HttpCode(204)
  @Roles(...WRITERS)
  async removePartner(@Tenant() t: TenantContext, @Param('id') id: string) {
    const r = await this.mysql.execute('DELETE FROM partner_corp WHERE id = ? AND tenant_id = ?', [Number(id), t.tenantId]);
    if (r.affectedRows === 0) throw new NotFoundException('白名单里没有这一项');
    await this.notifier.notify(t.tenantId, 'member');
  }
}
