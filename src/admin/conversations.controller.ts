import { Body, Controller, Get, HttpCode, NotFoundException, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { MysqlService } from '../database/mysql.service';
import { Roles, Tenant, TenantContext } from '../auth/tenant-context';
import { parse } from './validation';

const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
const bool01 = z.enum(['0', '1', 'true', 'false']).transform((v) => v === '1' || v === 'true');

const ListSchema = z.object({
  from: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  to: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  status: z.enum(['QUEUED', 'ACTIVE', 'ENDED']).optional(),
  handoff: bool01.optional(),
  lowConfidence: bool01.optional(),
  resolved: z.enum(['0', '1', 'null']).optional(),
  customer: z.string().max(64).optional(),
  chatId: z.string().max(128).optional(),
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  tenantId: z.string().optional(),
});

/**
 * 会话查询与排障（§13.2，P1-2）。所有查询带 tenant_id（取自令牌），跨租户的 id 一律 404。
 */
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly mysql: MysqlService) {}

  @Get()
  async list(@Tenant() t: TenantContext, @Query() q: unknown) {
    const f = parse(ListSchema, q);
    const where = ['c.tenant_id = ?'];
    const args: unknown[] = [t.tenantId];
    if (f.from) where.push('c.started_at >= ?'), args.push(new Date(f.from));
    if (f.to) where.push('c.started_at < ?'), args.push(new Date(f.to));
    if (f.status) where.push('c.status = ?'), args.push(f.status);
    if (f.handoff !== undefined) where.push('c.handoff = ?'), args.push(f.handoff ? 1 : 0);
    if (f.resolved) where.push(f.resolved === 'null' ? 'c.resolved IS NULL' : 'c.resolved = ?'), f.resolved !== 'null' && args.push(Number(f.resolved));
    if (f.customer) where.push('(c.customer_name LIKE ? OR c.chat_name LIKE ?)'), args.push(`%${f.customer}%`, `%${f.customer}%`);
    if (f.chatId) where.push('c.channel_chat_id = ?'), args.push(f.chatId);
    if (f.lowConfidence !== undefined) {
      where.push(`${f.lowConfidence ? '' : 'NOT '}EXISTS (SELECT 1 FROM turn x WHERE x.conversation_id = c.id AND x.tenant_id = c.tenant_id AND x.low_confidence = 1)`);
    }
    const cond = where.join(' AND ');
    const [{ total }] = await this.mysql.query<{ total: number }>(`SELECT COUNT(*) total FROM conversation c WHERE ${cond}`, args);
    const items = await this.mysql.query(
      `SELECT c.id, c.channel, c.channel_chat_id AS chatId, c.chat_name AS chatName, c.customer_name AS customerName, c.customer_phone_mask AS customerPhone,
              c.status, c.mic_owner AS micOwner, c.turn_count AS turnCount, c.handoff, c.handoff_reason AS handoffReason, c.emotion,
              c.frustration_count AS frustrationCount, c.resolved, c.end_reason AS endReason, c.rule_pack_version AS rulePackVersion, c.started_at AS startedAt, c.ended_at AS endedAt
         FROM conversation c WHERE ${cond} ORDER BY c.id DESC LIMIT ? OFFSET ?`,
      [...args, f.size, (f.page - 1) * f.size],
    );
    return { total: Number(total), page: f.page, size: f.size, items };
  }

  /** 会话详情：轮、意图片段、消息、检索、模型调用、转人工、背景、状态流转，用于排障回放 */
  @Get(':id')
  async detail(@Tenant() t: TenantContext, @Param('id', ParseIntPipe) id: number) {
    const [conv] = await this.mysql.query<Record<string, unknown>>('SELECT * FROM conversation WHERE id = ? AND tenant_id = ?', [id, t.tenantId]);
    if (!conv) throw new NotFoundException('会话不存在');
    const T = t.tenantId;
    const [turns, messages, handoffs, background, transitions] = await Promise.all([
      this.mysql.query<Record<string, unknown>>('SELECT * FROM turn WHERE conversation_id = ? AND tenant_id = ? ORDER BY seq', [id, T]),
      this.mysql.query('SELECT id, group_id AS groupId, sender_role AS senderRole, sender_name AS senderName, msg_type AS msgType, content, is_placeholder AS isPlaceholder, sent_at AS sentAt FROM message WHERE conversation_id = ? AND tenant_id = ? ORDER BY sent_at, id', [id, T]),
      this.mysql.query<Record<string, unknown>>('SELECT * FROM handoff_record WHERE conversation_id = ? AND tenant_id = ? ORDER BY id', [id, T]),
      this.mysql.query<{ content: unknown }>('SELECT content FROM conversation_background WHERE conversation_id = ? AND tenant_id = ?', [id, T]),
      this.mysql.query('SELECT * FROM state_transition_log WHERE tenant_id = ? AND entity_type = ? AND entity_id = ? ORDER BY id', [T, 'conversation', id]),
    ]);
    const turnIds = turns.map((r) => Number(r.id));
    const byTurn = async (sql: string) => (turnIds.length ? this.mysql.query<Record<string, unknown>>(sql, [T, turnIds]) : []);
    const [spans, retrievals, llmCalls] = await Promise.all([
      byTurn('SELECT * FROM intent_span WHERE tenant_id = ? AND turn_id IN (?) ORDER BY turn_id, idx'),
      byTurn('SELECT * FROM retrieval_log WHERE tenant_id = ? AND turn_id IN (?) ORDER BY id'),
      byTurn('SELECT id, trace_id, turn_id, stage, provider, model, prompt_key, input_tokens, output_tokens, latency_ms, status, created_at FROM llm_call_log WHERE tenant_id = ? AND turn_id IN (?) ORDER BY id'),
    ]);
    return {
      conversation: { ...conv, sensitive_words: json(conv.sensitive_words), customer_snapshot: json(conv.customer_snapshot) },
      background: background[0] ? json(background[0].content) : null,
      turns: turns.map((turn) => ({
        ...turn, decision: json(turn.decision), timings: json(turn.timings), final_check_msg_ids: json(turn.final_check_msg_ids),
        intentSpans: spans.filter((s) => Number(s.turn_id) === Number(turn.id)),
        retrievals: retrievals.filter((r) => Number(r.turn_id) === Number(turn.id)).map((r) => ({ ...r, filters: json(r.filters), results: json(r.results) })),
        llmCalls: llmCalls.filter((l) => Number(l.turn_id) === Number(turn.id)),
      })),
      messages,
      handoffs: handoffs.map((h) => ({ ...h, package: json(h.package) })),
      transitions,
    };
  }

  /** 手动结束会话（备用；正常由空闲计时结束）。没转人工、也没判定过的按“默认已解决”（§6.1） */
  @Post(':id/end')
  @HttpCode(200)
  @Roles('platform_admin', 'tenant_admin', 'operator')
  async end(@Tenant() t: TenantContext, @Param('id', ParseIntPipe) id: number) {
    const r = await this.mysql.execute(
      `UPDATE conversation SET status = 'ENDED', ended_at = NOW(3), end_reason = 'MANUAL',
              resolved = CASE WHEN resolved IS NULL AND handoff = 0 THEN 1 ELSE resolved END
        WHERE id = ? AND tenant_id = ? AND status <> 'ENDED'`, [id, t.tenantId]);
    if (r.affectedRows === 0) {
      const [c] = await this.mysql.query('SELECT id FROM conversation WHERE id = ? AND tenant_id = ?', [id, t.tenantId]);
      if (!c) throw new NotFoundException('会话不存在');
      return { ended: false, message: '会话已经结束' };
    }
    return { ended: true };
  }

  /** 是否解决：转人工的会话以客服处理结果为准，由客服 / 运营回填（Q14） */
  @Patch(':id/resolved')
  @Roles('platform_admin', 'tenant_admin', 'operator')
  async resolved(@Tenant() t: TenantContext, @Param('id', ParseIntPipe) id: number, @Body() body: unknown) {
    const b = parse(z.object({ resolved: z.union([z.literal(0), z.literal(1), z.null()]) }), body);
    const r = await this.mysql.execute('UPDATE conversation SET resolved = ? WHERE id = ? AND tenant_id = ?', [b.resolved, id, t.tenantId]);
    if (r.affectedRows === 0) throw new NotFoundException('会话不存在');
    return { id, resolved: b.resolved };
  }
}
