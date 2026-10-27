import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { RowDataPacket } from 'mysql2/promise';
import type { ChannelAdapter, OutboundMessage } from '../../contracts';
import { MysqlService } from '../../database/mysql.service';
import { WecomBotService } from '../wecom/wecom-bot.service';

const RETRIES = 2;
const RETRY_DELAY_MS = 300;

/**
 * 群消息正文。智能机器人主动推送（aibot_send_msg）的 markdown 不认 <@userid>，会原样显示成「<@NiKai>」，
 * 所以只发正文，不带 @ 标记。
 */
export function renderWecomMarkdown(msg: Pick<OutboundMessage, 'text'>): string {
  return msg.text ?? '';
}

/** RPA_ROOM_TITLES：JSON 对象 {"wr...": "群名称"}，解析失败按空表处理 */
function rpaRoomTitles(): Record<string, string> {
  try {
    return JSON.parse(process.env.RPA_ROOM_TITLES || '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

const TITLE_TTL_MS = 6 * 3600_000;
const titleCache = new Map<string, { title: string; at: number }>();
let contactToken: { value: string; exp: number } | undefined;

/**
 * 外部群 roomid → 群名称：优先 RPA_ROOM_TITLES 手工映射；否则用「客户联系」Secret 调 externalcontact/groupchat/get 自动获取。
 * 未命名的群接口返回空名称（客户端显示的是成员名拼接），这种群只能靠手工映射。
 */
export async function resolveRoomTitle(roomId: string, logger?: Logger): Promise<string | undefined> {
  const manual = rpaRoomTitles()[roomId];
  if (manual) return manual;
  const corpId = process.env.WECOM_CORPID;
  const secret = process.env.WECOM_CONTACT_SECRET;
  if (!roomId.startsWith('wr') || !corpId || !secret) return undefined;

  const hit = titleCache.get(roomId);
  if (hit && Date.now() - hit.at < TITLE_TTL_MS) return hit.title || undefined;
  try {
    if (!contactToken || Date.now() > contactToken.exp) {
      const t = (await (await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${secret}`, { signal: AbortSignal.timeout(5000) })).json()) as { errcode: number; errmsg: string; access_token?: string; expires_in?: number };
      if (t.errcode !== 0 || !t.access_token) throw new Error(`gettoken ${t.errcode} ${t.errmsg}`);
      contactToken = { value: t.access_token, exp: Date.now() + ((t.expires_in ?? 7200) - 300) * 1000 };
    }
    const r = (await (
      await fetch(`https://qyapi.weixin.qq.com/cgi-bin/externalcontact/groupchat/get?access_token=${contactToken.value}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: roomId, need_name: 0 }),
        signal: AbortSignal.timeout(5000),
      })
    ).json()) as { errcode: number; errmsg: string; group_chat?: { name?: string } };
    if (r.errcode === 42001 || r.errcode === 40014) contactToken = undefined;
    if (r.errcode !== 0) throw new Error(`groupchat/get ${r.errcode} ${r.errmsg}`);
    const title = r.group_chat?.name ?? '';
    titleCache.set(roomId, { title, at: Date.now() });
    if (!title) logger?.warn(`外部群 ${roomId} 未设置群名称，RPA 无法搜索，请在 RPA_ROOM_TITLES 中手工映射或给群命名`);
    return title || undefined;
  } catch (err) {
    logger?.warn(`获取外部群名称失败 ${roomId}: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * 企微渠道发送（方案 §11.1 ChannelAdapter）：经运行时已建立的智能机器人长连接主动推送（aibot_send_msg）。
 * 群消息发到 channelChatId，私信（交接包）发到 toUserId。失败重试 2 次（间隔 300ms），仍失败抛出由调用方记“发送失败”。
 * 长连接服务在发送时再取：它经消息处理依赖入站流水线，而入站流水线又注入本适配器，构造时注入会循环依赖。
 */
@Injectable()
export class WecomChannelAdapter implements ChannelAdapter {
  readonly channel = 'wecom_group' as const;
  private readonly logger = new Logger(WecomChannelAdapter.name);

  private bot?: WecomBotService;

  constructor(private readonly moduleRef: ModuleRef) {}

  async send(msg: OutboundMessage): Promise<{ channelMsgId?: string }> {
    this.bot ??= this.moduleRef.get(WecomBotService, { strict: false });
    const client = this.bot.getClient();
    const target = msg.toUserId ?? msg.channelChatId;
    if (!target) throw new Error('缺少发送目标（群 ID 或成员 ID）');

    const rpaUrl = process.env.RPA_SEND_URL;
    // 外部群由会话存档收进来时 chatId 是企微 roomid（wr...），官方长连接发不进外部群；
    // 能解析出群名称（手工映射或客户联系接口）即交给 RPA 按群名搜索发送
    const roomTitle = rpaUrl ? await resolveRoomTitle(target, this.logger) : undefined;
    // RPA 自己抓取的群直接以「群名称」作为 chatId（含中文/顿号）；企微原生 ID 均为 ASCII
    const isRpaChat = !!roomTitle || !/^[\x21-\x7e]+$/.test(target);
    if (rpaUrl && (isRpaChat || !client)) {
      try {
        const resp = await fetch(rpaUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId: roomTitle ?? target, content: renderWecomMarkdown(msg), mentions: await this.staffMentionNames(msg) }),
          signal: AbortSignal.timeout(20_000),
        });
        const body = (await resp.json().catch(() => ({}))) as { code?: number; message?: string };
        if (!resp.ok || (body.code !== undefined && body.code !== 0)) {
          throw new Error(`RPA 发送接口响应异常: HTTP ${resp.status} ${body.message ?? ''}`);
        }
        return { channelMsgId: `rpa_${Date.now()}` };
      } catch (err) {
        this.logger.error(`RPA 发送消息失败 → ${target}: ${(err as Error).message}`);
        throw err;
      }
    }

    if (!client) throw new Error('企微智能机器人长连接未建立，且未配置 RPA_SEND_URL');
    let lastErr: unknown;
    for (let i = 0; i <= RETRIES; i++) {
      try {
        const frame = await client.sendMessage(target, { msgtype: 'markdown', markdown: { content: renderWecomMarkdown(msg) } });
        return { channelMsgId: (frame as { headers?: { req_id?: string } })?.headers?.req_id };
      } catch (err) {
        lastErr = err;
        this.logger.warn(`发送失败（第 ${i + 1} 次）→ ${target}：${(err as Error).message}`);
        if (i < RETRIES) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /**
   * RPA 发送时需要真正 @ 的人：只取 mentions 里的客服（cs_staff），返回群内显示名，由 RPA 在输入框里逐个 @ 选人。
   * 客户是被回复方，不单独 @；查询失败时返回空表，不影响正文发送。
   */
  private async staffMentionNames(msg: OutboundMessage): Promise<string[]> {
    const ids = (msg.mentions ?? []).filter((id) => id && !/^w[mo]/.test(id));
    if (!ids.length || msg.toUserId) return [];
    try {
      const mysql = this.moduleRef.get(MysqlService, { strict: false });
      const [rows] = await mysql.getPool().query<RowDataPacket[]>(
        `SELECT wecom_user_id, name FROM cs_staff WHERE tenant_id = ? AND wecom_user_id IN (?) AND status = 1`,
        [msg.tenantId, ids],
      );
      const byId = new Map(rows.map((r) => [String(r.wecom_user_id), String(r.name)]));
      return ids.map((id) => byId.get(id)).filter((n): n is string => !!n);
    } catch (err) {
      this.logger.warn(`查询 @ 客服姓名失败：${(err as Error).message}`);
      return [];
    }
  }
}
