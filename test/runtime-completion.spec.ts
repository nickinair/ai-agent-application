/**
 * 替运行时补齐的几项：租户与角色识别、占位应答、看门狗兜底真正发出
 */
import { memberTypeOf, WecomMemberRoleService } from '../src/modules/wecom/wecom-member-role.service';
import { PlaceholderService } from '../src/modules/pipeline/placeholder.service';
import { WatchdogService } from '../src/modules/pipeline/watchdog.service';

describe('WecomMemberRoleService 租户与角色识别', () => {
  const make = (rows: { member?: any; bots?: string[]; staff?: string[]; account?: number }) => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: jest.fn(async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes('FROM chat_member')) return [rows.member ? [rows.member] : []];
        if (sql.includes('SELECT tenant_id FROM channel_account')) return [rows.account ? [{ tenant_id: rows.account }] : []];
        if (sql.includes('FROM channel_account')) return [(rows.bots ?? []).map((b) => ({ bot_user_id: b }))];
        if (sql.includes('FROM cs_staff')) return [(rows.staff ?? []).map((s) => ({ wecom_user_id: s }))];
        return [{ affectedRows: 1 }];
      }),
    };
    const svc = new WecomMemberRoleService({ WECOM_BOT_ID: 'bot_self', WECOM_TENANT_ID: 3 } as any, { getPool: () => pool } as any);
    return { svc, queries };
  };

  it('企微 ID 规则：wm / wo 开头是外部联系人，其余是本企业成员', () => {
    expect(memberTypeOf('wmAbCdEf123456')).toBe('EXTERNAL_WECHAT');
    expect(memberTypeOf('woAbCdEf123456')).toBe('EXTERNAL_WECOM');
    expect(memberTypeOf('ZhangSan')).toBe('INTERNAL');
    expect(memberTypeOf('wm')).toBe('INTERNAL');
  });

  it('租户：channel_account 登记了机器人就用它，否则用 WECOM_TENANT_ID', async () => {
    expect(await make({ account: 9 }).svc.tenantId()).toBe(9);
    expect(await make({}).svc.tenantId()).toBe(3);
  });

  it('优先级：人工设置 > 机器人 > 已同步身份 > 客服配置 > ID 规则', async () => {
    expect(await make({ member: { role: 'PARTNER', role_source: 'MANUAL' } }).svc.resolve(1, 'wecom_group', 'c', 'wmX1234567')).toEqual({ role: 'PARTNER', source: 'MANUAL' });
    expect((await make({}).svc.resolve(1, 'wecom_group', 'c', 'bot_self')).role).toBe('BOT');
    expect((await make({ member: { role: 'PARTNER', role_source: 'CHANNEL' } }).svc.resolve(1, 'wecom_group', 'c', 'woPartner001')).role).toBe('PARTNER');
    expect((await make({ staff: ['zhangsan'] }).svc.resolve(1, 'wecom_group', 'c', 'zhangsan')).role).toBe('STAFF_CS');
    expect((await make({}).svc.resolve(1, 'wecom_group', 'c', 'lisi_sales')).role).toBe('STAFF_OTHER');
    const { svc, queries } = make({});
    expect(await svc.resolve(1, 'wecom_group', 'c', 'wmCustomer001')).toEqual({ role: 'CUSTOMER', source: 'CHANNEL' });
    expect(queries.find((q) => q.sql.includes('INSERT INTO chat_member'))?.params).toEqual([1, 'wecom_group', 'c', 'wmCustomer001', null, 'EXTERNAL_WECHAT', 'CUSTOMER', 'CHANNEL']);
  });
});

describe('PlaceholderService 占位应答', () => {
  const make = (o: { mic?: 'BOT' | 'HUMAN'; botSent?: boolean; scripts?: Array<{ tenant_id: number; content: string; weight: number }>; status?: string } = {}) => {
    const added: any[] = [];
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    let setNx = 'OK';
    const redis = { getClient: () => ({ set: jest.fn(async () => { const r = setNx; setNx = null as any; return r; }) }) };
    const queue = { add: jest.fn(async (...a: unknown[]) => { added.push(a); }) };
    const pool = {
      query: jest.fn(async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes('FROM rp_param')) return [[{ param_value: '600' }]];
        if (sql.includes('FROM conversation')) return [[{ channel: 'wecom_group', channel_chat_id: 'chat_9', status: o.status ?? 'ACTIVE' }]];
        if (sql.includes("sender_role = 'BOT'")) return [o.botSent ? [{ 1: 1 }] : []];
        if (sql.includes('FROM rp_script')) return [o.scripts ?? []];
        return [{ affectedRows: 1 }];
      }),
    };
    const channel = { send: jest.fn(async () => ({})) };
    const mic = { getMicStatus: jest.fn(async () => ({ owner: o.mic ?? 'BOT' })) };
    const svc = new PlaceholderService({ getQueue: () => queue, createWorker: jest.fn() } as any, { getPool: () => pool } as any, redis as any, mic as any, channel as any);
    return { svc, added, queries, channel };
  };

  it('每个会话只预约一次，延迟取参数 ack_delay_ms', async () => {
    const { svc, added } = make();
    await svc.onCustomerMessage(1, 10, 'wmC1');
    await svc.onCustomerMessage(1, 10, 'wmC1');
    expect(added).toHaveLength(1);
    expect(added[0][1]).toEqual({ tenantId: 1, convId: 10, senderId: 'wmC1' });
    expect(added[0][2]).toMatchObject({ jobId: 'ack-10', delay: 600 });
  });

  it('到点发占位语（租户话术优先），@ 客户，落库为占位消息', async () => {
    const { svc, channel, queries } = make({ scripts: [{ tenant_id: 0, content: '平台话术', weight: 1 }, { tenant_id: 1, content: '收到，马上看', weight: 1 }] });
    expect(await svc.fire({ tenantId: 1, convId: 10, senderId: 'wmC1' })).toBe(true);
    expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'PLACEHOLDER', text: '收到，马上看', channelChatId: 'chat_9', mentions: ['wmC1'] }));
    expect(queries.find((q) => q.sql.includes('INSERT INTO message'))?.sql).toContain('is_placeholder');
  });

  it('话筒在人工手里、机器人已回过话、会话已结束时不发', async () => {
    for (const o of [{ mic: 'HUMAN' as const }, { botSent: true }, { status: 'ENDED' }]) {
      const { svc, channel } = make(o);
      expect(await svc.fire({ tenantId: 1, convId: 10, senderId: 'wmC1' })).toBe(false);
      expect(channel.send).not.toHaveBeenCalled();
    }
  });
});

describe('WatchdogService 兜底话术真正发出', () => {
  it('超时组：群里发兜底话术并 @ 本组客户，轮记为降级', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: jest.fn(async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes('FROM msg_group')) return [[{ id: 502, tenant_id: 1, conversation_id: 1002, status: 'UNDERSTANDING', sender_channel_user_id: 'wmC1' }]];
        if (sql.includes('FROM conversation')) return [[{ channel: 'wecom_group', channel_chat_id: 'chat_corp_001' }]];
        if (sql.includes('INSERT INTO message')) return [{ insertId: 1 }];
        return [{ affectedRows: 1 }];
      }),
    };
    const redisClient = { keys: jest.fn(async () => ['ag:inflight:1002']), hgetall: jest.fn(async () => ({ groupId: '502', sealedAt: String(1_000), turnId: '22' })), del: jest.fn() };
    const channel = { send: jest.fn(async () => ({})) };
    const svc = new WatchdogService({} as any, { getPool: () => pool } as any, { getClient: () => redisClient } as any, { transition: jest.fn() } as any, { onTurnDone: jest.fn() } as any, channel as any);
    const report = await svc.scanAndRecover(20_000);
    expect(report.recovered).toBe(1);
    expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({ channelChatId: 'chat_corp_001', text: '网络繁忙，稍后为您服务', mentions: ['wmC1'] }));
    const upd = queries.find((q) => q.sql.includes("reply_status = 'DEGRADED'"));
    expect(upd?.params).toEqual(['网络繁忙，稍后为您服务', '22', 1]);
    expect(queries.find((q) => q.sql.startsWith('UPDATE msg_group SET turn_id'))?.params).toEqual(['22', 502]);
  });
});

describe('BullMQ 自定义 jobId 规则（含冒号时必须正好 3 段，否则入队直接报错）', () => {
  const valid = (id: string) => !id.includes(':') || id.split(':').length === 3;
  it('运行时和发送端用到的 jobId 都合规', () => {
    const ids = ['quiet:101:wmC1@3', 'hard:101:wmC1@1', 'idle:101:2', 'hwait:101:4', 'turn:30:0', 'turn:30:1', 'post:30:0', 'ack-10'];
    expect(ids.filter((id) => !valid(id))).toEqual([]);
  });
  it('源码里拼 jobId 的模板都合规（按冒号段数检查）', () => {
    const { readFileSync, readdirSync } = require('node:fs');
    const { join } = require('node:path');
    const files: string[] = [];
    const walk = (d: string) => readdirSync(d, { withFileTypes: true }).forEach((e: any) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.ts') && files.push(join(d, e.name))));
    walk(join(__dirname, '../src'));
    const bad: string[] = [];
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(/jobId(?:\s*[:=]\s*)`([^`]+)`/g)) {
        const tpl = m[1].replace(/\$\{[^}]+\}/g, 'x');
        if (!valid(tpl)) bad.push(`${f}: ${m[1]}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
