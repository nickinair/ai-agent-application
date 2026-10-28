import { WecomGroupMessageService } from '../src/modules/wecom/wecom-group-message.service';

/**
 * 线上 10-23 复现：同一条「@机器人 你咋不说话」经长连接（msgid=f3490…hex）与会话存档（msgid=1485…_1792…）
 * 各到一次，被封成两组、机器人回了两遍。跨通道内容去重后只应投递一次。
 */
describe('企微跨通道（长连接 + 会话存档）重复消息去重', () => {
  const env: any = { WECOM_BOT_ID: 'aibot_x', WECOM_STAFF_MENTIONS: '@客服' };
  const memberRoles: any = { tenantId: jest.fn().mockResolvedValue(1), resolve: jest.fn().mockResolvedValue({ role: 'CUSTOMER' }) };

  function make() {
    const pipeline: any = { onInbound: jest.fn().mockResolvedValue({ status: 'PROCESSED' }) };
    const svc = new WecomGroupMessageService(env, pipeline, memberRoles);
    return { svc, pipeline };
  }

  const wsFrame = (msgid: string, text: string) =>
    ({ headers: { req_id: 'r1' }, body: { msgid, chattype: 'group', chatid: 'wr_room', from: { userid: 'wm_cust_1' }, msgtype: 'text', text: { content: text } } }) as any;

  const financeEvent = (msgid: string, text: string) =>
    ({ seq: 1, msgid, roomid: 'wr_room', isExternalRoom: true, sender: 'wm_cust_1', timestamp: Date.now(), msgtype: 'text', contentSummary: text, payload: { text: { content: text } } }) as any;

  it('长连接先到、会话存档后到：只投递一次', async () => {
    const { svc, pipeline } = make();
    await svc.handleIncomingMessage({} as any, wsFrame('f349085a528139ebb83c41367b79dcb3', '@智能助理 你咋不说话'));
    const r = await svc.handleFinanceInboundEvent(financeEvent('14857537415743232512_1792750905184', '@智能助理 你咋不说话'));
    expect(pipeline.onInbound).toHaveBeenCalledTimes(1);
    expect(r.handled).toBe(false);
  });

  it('会话存档先到、长连接后到：只投递一次', async () => {
    const { svc, pipeline } = make();
    await svc.handleFinanceInboundEvent(financeEvent('111_222', '电池延保多少钱'));
    await svc.handleIncomingMessage({} as any, wsFrame('aaaa', '电池延保多少钱'));
    expect(pipeline.onInbound).toHaveBeenCalledTimes(1);
  });

  it('不同正文不受影响', async () => {
    const { svc, pipeline } = make();
    await svc.handleFinanceInboundEvent(financeEvent('1_1', '你好'));
    await svc.handleFinanceInboundEvent(financeEvent('2_2', '延保多少钱'));
    expect(pipeline.onInbound).toHaveBeenCalledTimes(2);
  });
});
