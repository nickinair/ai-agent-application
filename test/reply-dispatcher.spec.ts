/**
 * 发送端（封组之后：末检 → 发出 → 转人工话筒 → 回报核心服务）单元测试
 */
import { ReplyDispatcherService } from '../src/modules/reply/reply-dispatcher.service';
import { renderWecomMarkdown } from '../src/modules/reply/wecom-channel.adapter';
import type { PostJob } from '../src/modules/reply/reply.contracts';

const SEND = Object.assign(new String('SEND'), { action: 'SEND' });

function makePost(over: Partial<PostJob> = {}): PostJob {
  return {
    version: 1, traceId: 't-1', tenantId: 1, conversationId: 10, turnId: 20, groupId: 30, mergeCount: 0,
    senderUserId: 'cust_1', kind: 'REPLY',
    reply: { tenantId: 1, channel: 'wecom_group', channelChatId: 'chat_1', kind: 'REPLY', text: '延保 3 年 2999 元', mentions: ['cust_1'], conversationId: 10 },
    confidence: 0.9, lowConfidence: false, degraded: false, sealedAt: Date.now() - 1200, generatedAt: Date.now(), timings: {},
    trace: { relation: null, intents: [], scene: '售前顾问', action: 'ANSWER' },
    ...over,
  };
}

describe('ReplyDispatcherService', () => {
  let groupStatus: string;
  let queries: Array<{ sql: string; params: unknown[] }>;
  let added: Array<{ queue: string; name: string; data: any; opts: any }>;
  let finalCheck: { finalCheck: jest.Mock; safeSend: jest.Mock };
  let mic: { lockHandoff: jest.Mock; seizeByStaff: jest.Mock };
  let timers: { scheduleHumanWait: jest.Mock; scheduleIdle: jest.Mock };
  let sealer: { onTurnDone: jest.Mock };
  let states: { transition: jest.Mock };
  let channel: { send: jest.Mock };
  let svc: ReplyDispatcherService;

  beforeEach(() => {
    groupStatus = 'FINAL_CHECKING';
    queries = [];
    added = [];
    const pool = {
      query: jest.fn(async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes('FROM msg_group')) return [[{ status: groupStatus, merged_text: '延保多少钱' }]];
        if (sql.includes('FROM conversation')) return [[{ customer_snapshot: JSON.stringify({ name: '王先生', phoneMasked: '138****1234' }), rule_pack_version: 'v1.0.0' }]];
        if (sql.includes('FROM turn')) return [[{ seq: 2 }]];
        if (sql.includes('FROM message')) return [[{ id: 1, channel_msg_id: 'm1', sender_role: 'CUSTOMER', content: '延保多少钱', sent_at: new Date() }, { id: 2, channel_msg_id: 'm2', sender_role: 'CUSTOMER', content: '不对，我问的是三电', sent_at: new Date() }]];
        if (sql.startsWith('INSERT INTO message')) return [{ insertId: 99 }];
        return [{ affectedRows: 1 }];
      }),
    };
    const queues = {
      createWorker: jest.fn(),
      getQueue: jest.fn((queue: string) => ({ add: jest.fn(async (name: string, data: any, opts: any) => { added.push({ queue, name, data, opts }); }) })),
    };
    finalCheck = { finalCheck: jest.fn(async () => SEND), safeSend: jest.fn(async () => true) };
    mic = { lockHandoff: jest.fn(async () => ({ epoch: 3 })), seizeByStaff: jest.fn(async () => ({ epoch: 4 })) };
    timers = { scheduleHumanWait: jest.fn(async () => undefined), scheduleIdle: jest.fn(async () => 1) };
    sealer = { onTurnDone: jest.fn(async () => undefined) };
    states = { transition: jest.fn(async () => undefined) };
    channel = { send: jest.fn(async () => ({})) };
    svc = new ReplyDispatcherService({ WECOM_BOT_ENABLED: true, WECOM_BOT_ID: 'bot' } as any, queues as any, { getPool: () => pool } as any, finalCheck as any, mic as any, timers as any, sealer as any, states as any, channel as any);
  });

  const results = () => added.filter((a) => a.queue === 'agent.queue.turn-result').map((a) => a.data);
  const turnUpdate = () => queries.find((q) => q.sql.startsWith('UPDATE turn SET reply_status = ?, reply_msg_id'));

  it('正常发出：末检只看本组发送人，发出后写 BOT 消息与耗时，回报 SENT 并释放会话锁', async () => {
    const out = await svc.dispatch(makePost());
    expect(out).toEqual({ result: 'SENT', replyMessageId: 99 });
    expect(finalCheck.finalCheck.mock.calls[0][0]).toMatchObject({ senderId: 'cust_1', groupText: '延保多少钱', mergeCount: 0 });
    expect(finalCheck.safeSend.mock.calls[0][1]).toMatchObject({ channelChatId: 'chat_1', mentions: ['cust_1'] });
    const upd = turnUpdate()!;
    expect(upd.params[0]).toBe('SENT');
    expect(upd.params[1]).toBe(99);
    expect(upd.params[2]).toBeGreaterThanOrEqual(1200);
    expect(results()).toEqual([{ turnId: 20, groupId: 30, mergeCount: 0, result: 'SENT', replyMessageId: 99 }]);
    expect(sealer.onTurnDone).toHaveBeenCalledWith(10);
    expect(mic.lockHandoff).not.toHaveBeenCalled();
  });

  it('降级回复记 DEGRADED', async () => {
    await svc.dispatch(makePost({ degraded: true }));
    expect(turnUpdate()!.params[0]).toBe('DEGRADED');
  });

  it('组已不在末检（看门狗兜底过）：不发，回报 VOIDED，不动会话锁', async () => {
    groupStatus = 'SENT';
    const out = await svc.dispatch(makePost());
    expect(out.result).toBe('VOIDED');
    expect(finalCheck.finalCheck).not.toHaveBeenCalled();
    expect(sealer.onTurnDone).not.toHaveBeenCalled();
    expect(results()[0].result).toBe('VOIDED');
  });

  it('末检话筒被抢：回报 VOIDED，不发', async () => {
    finalCheck.finalCheck.mockResolvedValueOnce(Object.assign(new String('VOID'), { action: 'VOID' }));
    const out = await svc.dispatch(makePost());
    expect(out.result).toBe('VOIDED');
    expect(finalCheck.safeSend).not.toHaveBeenCalled();
    expect(sealer.onTurnDone).toHaveBeenCalled();
  });

  it('发前最后一刻话筒被抢（safeSend 返回 false）：回报 VOIDED', async () => {
    finalCheck.safeSend.mockResolvedValueOnce(false);
    expect((await svc.dispatch(makePost())).result).toBe('VOIDED');
    expect(queries.some((q) => q.sql.startsWith('INSERT INTO message'))).toBe(false);
  });

  it('末检纠正：回报 RECOMPUTE，以 mergeCount + 1 重新投递理解，会话锁保持', async () => {
    finalCheck.finalCheck.mockImplementationOnce(async (ctx: any) => {
      ctx.groupText += '\n不对，我问的是三电';
      ctx.mergeCount = 1;
      ctx.sealedAt = 1700000000000;
      return Object.assign(new String('RECOMPUTE'), { action: 'RECOMPUTE' });
    });
    const out = await svc.dispatch(makePost());
    expect(out.result).toBe('RECOMPUTE');
    expect(results()[0]).toMatchObject({ result: 'RECOMPUTE', mergeCount: 0 });
    const turn = added.find((a) => a.queue === 'agent.queue.turn')!;
    expect(turn.opts.jobId).toBe('turn:30:1');
    expect(turn.data).toMatchObject({ groupId: 30, turnId: 20 });
    expect(turn.data.context).toMatchObject({
      traceId: 't-1', tenantId: 1, conversationId: 10, isFirstTurn: false, mergeCount: 1, sealedAt: 1700000000000,
      groupText: '延保多少钱\n不对，我问的是三电', customer: { name: '王先生' }, rulePackVersion: 'v1.0.0',
    });
    expect(turn.data.context.groupMessages).toHaveLength(2);
    expect(turn.data.context.senderId).toBeUndefined();
    expect(turn.data.context.reply).toBeUndefined();
    expect(finalCheck.safeSend).not.toHaveBeenCalled();
    expect(sealer.onTurnDone).not.toHaveBeenCalled();
  });

  it('转人工且锁话筒：私信交接包，话筒锁给人工，不预约自动接回', async () => {
    const privateMessage = { tenantId: 1, channel: 'wecom_group' as const, channelChatId: 'chat_1', kind: 'HANDOFF_PACKAGE' as const, text: '交接包', toUserId: 'cs_li' };
    await svc.dispatch(makePost({ handoff: { trigger: 'SENSITIVE', evidence: 'P0', staff: { id: 5, name: '李客服', wecomUserId: 'cs_li' }, privateMessage, lockMic: true } }));
    expect(channel.send).toHaveBeenCalledWith(privateMessage);
    expect(mic.lockHandoff).toHaveBeenCalledWith(10, 'cs_li', 'AI_HANDOFF_SENSITIVE');
    expect(timers.scheduleHumanWait).not.toHaveBeenCalled();
  });

  it('转人工不锁话筒：人工持话筒，预约人工未回复自动接回', async () => {
    await svc.dispatch(makePost({ handoff: { trigger: 'BLIND_SPOT', evidence: '低置信', staff: { id: 5, name: '李客服', wecomUserId: 'cs_li' }, lockMic: false } }));
    expect(mic.seizeByStaff).toHaveBeenCalledWith(10, 'cs_li', 'STAFF_CS', 'AI_HANDOFF_BLIND_SPOT');
    expect(timers.scheduleHumanWait).toHaveBeenCalledWith(10, 'cust_1', 4);
  });

  it('私信失败不影响群内回复的结果', async () => {
    channel.send.mockRejectedValueOnce(new Error('ws closed'));
    const out = await svc.dispatch(makePost({ handoff: { trigger: 'INTENT', evidence: '', staff: null, privateMessage: { tenantId: 1, channel: 'wecom_group', channelChatId: '', kind: 'HANDOFF_PACKAGE', text: 'x', toUserId: 'cs' }, lockMic: true } }));
    expect(out.result).toBe('SENT');
    expect(mic.lockHandoff).toHaveBeenCalledWith(10, '', 'AI_HANDOFF_INTENT');
  });

  it('收尾话术：发出后启动收尾空闲计时', async () => {
    await svc.dispatch(makePost({ kind: 'CLOSE' }));
    expect(timers.scheduleIdle).toHaveBeenCalledWith(10, 'CLOSE');
  });

  it('机器人关闭（SILENT）：不末检、不发，组结束，回报 SENT', async () => {
    const out = await svc.dispatch(makePost({ kind: 'SILENT', reply: undefined }));
    expect(out.result).toBe('SENT');
    expect(finalCheck.finalCheck).not.toHaveBeenCalled();
    expect(states.transition).toHaveBeenCalledWith('GROUP', 30, 'FINAL_CHECKING', 'SENT', expect.objectContaining({ reason: 'BOT_SILENT' }));
    expect(sealer.onTurnDone).toHaveBeenCalled();
  });

  it('发送异常：轮记 SEND_FAILED、组作废，回报 SEND_FAILED 并释放会话锁', async () => {
    finalCheck.safeSend.mockRejectedValueOnce(new Error('企微长连接未建立'));
    const out = await svc.dispatch(makePost());
    expect(out.result).toBe('SEND_FAILED');
    expect(queries.some((q) => q.sql.includes("reply_status = 'SEND_FAILED'"))).toBe(true);
    expect(states.transition).toHaveBeenCalledWith('GROUP', 30, 'FINAL_CHECKING', 'VOIDED', expect.objectContaining({ reason: 'SEND_FAILED' }));
    expect(results()[0].result).toBe('SEND_FAILED');
    expect(sealer.onTurnDone).toHaveBeenCalled();
  });
});

describe('renderWecomMarkdown', () => {
  it('群消息先 @ 再正文，@ 去重', () => {
    expect(renderWecomMarkdown({ text: '您好', mentions: ['a', 'b', 'a'] })).toBe('<@a> <@b> 您好');
  });
  it('私信不带 @', () => {
    expect(renderWecomMarkdown({ text: '交接包', mentions: ['a'], toUserId: 'cs' })).toBe('交接包');
  });
});

describe('ChannelRouter / TestChannelRecorder', () => {
  it('测试会话只记录不外发，其余走企微', async () => {
    const { ChannelRouter } = await import('../src/modules/reply/channel-router');
    const { TestChannelRecorder } = await import('../src/modules/reply/test-channel.recorder');
    const lists = new Map<string, string[]>();
    const multi: any = {
      rpush: (k: string, v: string) => { lists.set(k, [...(lists.get(k) ?? []), v]); return multi; },
      ltrim: () => multi, expire: () => multi, exec: async () => [],
    };
    const redis = { getClient: () => ({ multi: () => multi, lrange: async (k: string) => lists.get(k) ?? [] }) };
    const recorder = new TestChannelRecorder(redis as any);
    const wecom = { send: jest.fn(async () => ({ channelMsgId: 'w1' })) };
    const router = new ChannelRouter(wecom as any, recorder);
    await router.send({ tenantId: 1, channel: 'test', channelChatId: 'c1', kind: 'REPLY', text: '你好', mentions: ['u1'] });
    await router.send({ tenantId: 1, channel: 'wecom_group', channelChatId: 'c2', kind: 'REPLY', text: '你好' });
    expect(wecom.send).toHaveBeenCalledTimes(1);
    expect(await recorder.sentTo('c1')).toEqual([expect.objectContaining({ text: '你好', mentions: ['u1'], kind: 'REPLY' })]);
  });
});
