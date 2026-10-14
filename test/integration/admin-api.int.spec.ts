/**
 * 管理 API 集成测试（真实 MySQL，已执行迁移）：
 *   IT_MYSQL_URL=mysql://root:pw@127.0.0.1:13306/agent_platform npx jest test/integration
 */
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { hashPassword } from '../../src/auth/auth.service';
import { ENV, loadEnv } from '../../src/config/env';
import { MysqlService } from '../../src/database/mysql.service';
import { ConfigNotifier } from '../../src/infra/config-notifier';

const enabled = !!process.env.IT_MYSQL_URL;
const d = enabled ? describe : describe.skip;

d('管理 API', () => {
  let app: INestApplication;
  let base = '';
  let mysql: MysqlService;
  const notified: unknown[] = [];
  const ids: Record<string, number> = {};
  const codes = ['it-acme', 'it-other'];

  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const res = await fetch(`${base}/api/admin${path}`, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const login = async (tenantCode: string, username: string, password = 'Agent2026pass') => (await call('POST', '/auth/login', undefined, { tenantCode, username, password })).body.token as string;

  beforeAll(async () => {
    const env = loadEnv({ MYSQL_URL: process.env.IT_MYSQL_URL, JWT_SECRET: 'it-secret-'.repeat(4) });
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ENV).useValue(env)
      .overrideProvider(ConfigNotifier).useValue({ notify: async (...a: unknown[]) => void notified.push(a) })
      .compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api/admin', { exclude: ['health'] });
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    mysql = app.get(MysqlService);

    for (const code of codes) {
      const [t] = await mysql.query<{ id: number }>('SELECT id FROM tenant WHERE code = ?', [code]);
      if (t) for (const tb of ['admin_account', 'conversation', 'turn', 'handoff_record', 'chat_member', 'partner_corp']) await mysql.execute(`DELETE FROM ${tb} WHERE tenant_id = ?`, [t.id]);
      await mysql.execute('DELETE FROM tenant WHERE code = ?', [code]);
      ids[code] = (await mysql.execute(`INSERT INTO tenant (code, name, industry) VALUES (?, ?, 'auto_aftermarket')`, [code, code])).insertId;
    }
    await mysql.execute(`DELETE FROM admin_account WHERE tenant_id = 0 AND username = 'it-root'`);
    const hash = await hashPassword('Agent2026pass');
    const T = ids['it-acme'];
    await mysql.execute(`INSERT INTO admin_account (tenant_id, username, password_hash, role) VALUES (?, 'ops', ?, 'operator'), (?, 'label', ?, 'labeler'), (0, 'it-root', ?, 'platform_admin'), (?, 'ops', ?, 'operator')`,
      [T, hash, T, hash, hash, ids['it-other'], hash]);
    ids.conv = (await mysql.execute(`INSERT INTO conversation (tenant_id, channel, channel_chat_id, chat_name, customer_name, status, handoff, rule_pack_version, started_at) VALUES (?, 'wecom_group', 'g1', '王先生-整车延保', '王先生', 'ACTIVE', 1, 'v1', NOW(3))`, [T])).insertId;
    ids.turn = (await mysql.execute(`INSERT INTO turn (tenant_id, conversation_id, seq, status, low_confidence, rule_pack_version, started_at) VALUES (?, ?, 1, 'DONE', 1, 'v1', NOW(3))`, [T, ids.conv])).insertId;
    ids.handoff = (await mysql.execute(`INSERT INTO handoff_record (tenant_id, conversation_id, turn_id, trigger_type, evidence, package, created_at) VALUES (?, ?, ?, 'BLIND_SPOT', '连续 2 轮低置信', '{"problems":[]}', NOW(3))`, [T, ids.conv, ids.turn])).insertId;
    await mysql.execute(`INSERT INTO chat_member (tenant_id, channel, channel_chat_id, member_id, member_type, role, role_source) VALUES (?, 'wecom_group', 'g1', 'wo-1', 'EXTERNAL_WECOM', 'CUSTOMER', 'CHANNEL'), (?, 'wecom_group', 'g1', 'wm-2', 'EXTERNAL_WECHAT', 'CUSTOMER', 'CHANNEL')`, [T, T]);
  });

  afterAll(async () => {
    for (const code of codes) for (const tb of ['admin_account', 'conversation', 'turn', 'handoff_record', 'chat_member', 'partner_corp']) await mysql.execute(`DELETE FROM ${tb} WHERE tenant_id = ?`, [ids[code]]);
    await mysql.execute(`DELETE FROM tenant WHERE code IN (?)`, [codes]);
    await mysql.execute(`DELETE FROM admin_account WHERE tenant_id = 0 AND username = 'it-root'`);
    await app.close();
  });

  it('未登录 401；健康检查不需要登录', async () => {
    expect((await call('GET', '/conversations')).status).toBe(401);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it('S24 会话查询、详情、转人工记录；按条件筛选', async () => {
    const token = await login('it-acme', 'ops');
    const list = await call('GET', '/conversations?handoff=1&lowConfidence=1&customer=王', token);
    expect(list.body).toMatchObject({ total: 1, items: [{ id: ids.conv, customerName: '王先生' }] });
    expect((await call('GET', '/conversations?handoff=0', token)).body.total).toBe(0);
    const detail = await call('GET', `/conversations/${ids.conv}`, token);
    expect(detail.body.turns[0]).toMatchObject({ id: ids.turn, intentSpans: [], retrievals: [] });
    expect(detail.body.handoffs[0].package).toEqual({ problems: [] });
    const h = await call('GET', '/handoffs?trigger=BLIND_SPOT', token);
    expect(h.body).toMatchObject({ total: 1, byTrigger: { BLIND_SPOT: 1 }, items: [{ id: ids.handoff, customerName: '王先生' }] });
    expect((await call('GET', `/handoffs/${ids.handoff}`, token)).body.package).toEqual({ problems: [] });
  });

  it('租户隔离：别的租户的账号查不到、改不了；不能用 tenantId 越权', async () => {
    const other = await login('it-other', 'ops');
    expect((await call('GET', '/conversations', other)).body.total).toBe(0);
    expect((await call('GET', `/conversations/${ids.conv}`, other)).status).toBe(404);
    expect((await call('GET', `/handoffs/${ids.handoff}`, other)).status).toBe(404);
    expect((await call('PATCH', `/conversations/${ids.conv}/resolved`, other, { resolved: 1 })).status).toBe(404);
    expect((await call('GET', `/conversations?tenantId=${ids['it-acme']}`, other)).status).toBe(403);
  });

  it('平台管理员必须指定租户', async () => {
    const root = await login('platform', 'it-root');
    expect((await call('GET', '/conversations', root)).status).toBe(403);
    expect((await call('GET', `/conversations?tenantId=${ids['it-acme']}`, root)).body.total).toBe(1);
  });

  it('角色：标注员只读；运营可回填是否解决、改成员角色、维护白名单，并通知核心服务', async () => {
    const label = await login('it-acme', 'label');
    expect((await call('PATCH', `/conversations/${ids.conv}/resolved`, label, { resolved: 1 })).status).toBe(403);
    const ops = await login('it-acme', 'ops');
    expect((await call('PATCH', `/conversations/${ids.conv}/resolved`, ops, { resolved: 0 })).body).toEqual({ id: ids.conv, resolved: 0 });
    expect((await call('PATCH', `/conversations/${ids.conv}/resolved`, ops, { resolved: 2 })).status).toBe(400);

    expect((await call('PATCH', '/chats/g1/members/wo-1', ops, { role: 'PARTNER' })).status).toBe(200);
    await call('PATCH', '/chats/g1/members/wm-2', ops, { isPrimary: true });
    const members = (await call('GET', '/chats/g1/members', ops)).body;
    expect(members.find((m: { memberId: string }) => m.memberId === 'wo-1')).toMatchObject({ role: 'PARTNER', roleSource: 'MANUAL' });
    expect(members.find((m: { memberId: string }) => m.memberId === 'wm-2')).toMatchObject({ isPrimary: 1 });
    expect((await call('PATCH', '/chats/g1/members/nobody', ops, { role: 'PARTNER' })).status).toBe(404);

    await call('POST', '/partner-corps', ops, { corpName: '平安保险深圳分公司' });
    const corps = (await call('GET', '/partner-corps', ops)).body;
    expect(corps.map((c: { corpName: string }) => c.corpName)).toEqual(['平安保险深圳分公司']);
    expect((await call('DELETE', `/partner-corps/${corps[0].id}`, ops)).status).toBe(204);
    expect(notified.filter((n) => (n as unknown[])[1] === 'member').length).toBe(4);

    const ended = await call('POST', `/conversations/${ids.conv}/end`, ops);
    expect(ended.body).toEqual({ ended: true });
    const [c] = await mysql.query<{ status: string; end_reason: string; resolved: number }>('SELECT status, end_reason, resolved FROM conversation WHERE id = ?', [ids.conv]);
    expect(c).toEqual({ status: 'ENDED', end_reason: 'MANUAL', resolved: 0 }); // 已回填的不被覆盖
  });

  it('登录：密码错误统一提示；连续失败 5 次锁定', async () => {
    const bad = await call('POST', '/auth/login', undefined, { tenantCode: 'it-acme', username: 'nobody', password: 'x' });
    expect(bad).toEqual({ status: 401, body: expect.objectContaining({ message: '租户、账号或密码不正确' }) });
    for (let i = 0; i < 4; i++) await call('POST', '/auth/login', undefined, { tenantCode: 'it-acme', username: 'label', password: 'wrong' });
    const locked = await call('POST', '/auth/login', undefined, { tenantCode: 'it-acme', username: 'label', password: 'Agent2026pass' });
    expect(locked.status).toBe(429);
  });
});
