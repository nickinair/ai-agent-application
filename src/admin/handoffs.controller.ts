import { BadRequestException, Controller, Get, NotFoundException, Param, ParseIntPipe, Query } from '@nestjs/common';
import { z } from 'zod';
import { Tenant, TenantContext } from '../auth/tenant-context';
import { MysqlService } from '../database/mysql.service';
import { parse } from './validation';

const ListSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  trigger: z.enum(['SENSITIVE', 'INTENT', 'FRUSTRATION', 'BLIND_SPOT', 'MANUAL']).optional(),
  staffId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  tenantId: z.string().optional(),
});

/** 转人工记录（§13.2，P1-2）：交接包已私信客服，这里供运营复盘 */
@Controller('handoffs')
export class HandoffsController {
  constructor(private readonly mysql: MysqlService) {}

  @Get()
  async list(@Tenant() t: TenantContext, @Query() q: unknown) {
    const f = parse(ListSchema, q);
    const where = ['h.tenant_id = ?'];
    const args: unknown[] = [t.tenantId];
    for (const [k, v] of [['from', f.from], ['to', f.to]] as const) {
      if (!v) continue;
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) throw new BadRequestException(`${k} 不是合法时间`);
      where.push(k === 'from' ? 'h.created_at >= ?' : 'h.created_at < ?');
      args.push(d);
    }
    if (f.trigger) where.push('h.trigger_type = ?'), args.push(f.trigger);
    if (f.staffId) where.push('h.staff_id = ?'), args.push(f.staffId);
    const cond = where.join(' AND ');
    const [{ total }] = await this.mysql.query<{ total: number }>(`SELECT COUNT(*) total FROM handoff_record h WHERE ${cond}`, args);
    const items = await this.mysql.query(
      `SELECT h.id, h.conversation_id AS conversationId, h.turn_id AS turnId, h.trigger_type AS triggerType, h.evidence, h.staff_id AS staffId, s.name AS staffName,
              h.staff_first_reply_at AS staffFirstReplyAt, h.auto_returned_at AS autoReturnedAt, h.created_at AS createdAt,
              c.chat_name AS chatName, c.customer_name AS customerName, c.resolved
         FROM handoff_record h
         LEFT JOIN cs_staff s ON s.id = h.staff_id AND s.tenant_id = h.tenant_id
         LEFT JOIN conversation c ON c.id = h.conversation_id AND c.tenant_id = h.tenant_id
        WHERE ${cond} ORDER BY h.id DESC LIMIT ? OFFSET ?`,
      [...args, f.size, (f.page - 1) * f.size],
    );
    // 按原因汇总，便于看转人工率构成
    const byTrigger = await this.mysql.query<{ trigger_type: string; n: number }>(`SELECT h.trigger_type, COUNT(*) n FROM handoff_record h WHERE ${cond} GROUP BY h.trigger_type`, args);
    return { total: Number(total), page: f.page, size: f.size, byTrigger: Object.fromEntries(byTrigger.map((r) => [r.trigger_type, Number(r.n)])), items };
  }

  @Get(':id')
  async detail(@Tenant() t: TenantContext, @Param('id', ParseIntPipe) id: number) {
    const [h] = await this.mysql.query<Record<string, unknown>>('SELECT * FROM handoff_record WHERE id = ? AND tenant_id = ?', [id, t.tenantId]);
    if (!h) throw new NotFoundException('转人工记录不存在');
    return { ...h, package: typeof h.package === 'string' ? JSON.parse(h.package) : h.package };
  }
}
