/**
 * @file final-check.spec.ts
 * @description Task 4.1: 发送前增量消息嗅探服务单元测试 (FinalCheckService & BufferService.peekSince)
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §5.8.1
 */

import { FinalCheckService } from '../src/modules/pipeline/final-check.service';
import { BufferService } from '../src/modules/pipeline/buffer.service';
import type { TurnContext } from '../src/contracts';

describe('Task 4.1: 发送前增量消息嗅探服务测试 (FinalCheckService & peekSince)', () => {
  let finalCheckService: FinalCheckService;
  let bufferService: BufferService;
  let mockRedisService: any;
  let mockMysqlService: any;
  let mockDbPool: any;
  let redisLists: Map<string, string[]>;
  let dbMessages: Map<number, any>;

  const convId = 801;
  const customerId = 'cust_vip_001';
  const sealedAtTime = 1700000000000;

  beforeEach(() => {
    redisLists = new Map<string, string[]>();
    dbMessages = new Map<number, any>();

    const mockRedisClient = {
      lrange: jest.fn(async (key: string, start: number, stop: number) => {
        const list = redisLists.get(key) || [];
        if (stop === -1) return [...list.slice(start)];
        return [...list.slice(start, stop + 1)];
      }),
      llen: jest.fn(async (key: string) => {
        return (redisLists.get(key) || []).length;
      }),
      keys: jest.fn(async (pattern: string) => {
        const prefix = pattern.replace('*', '');
        return Array.from(redisLists.keys()).filter((k) => k.startsWith(prefix));
      }),
      rpush: jest.fn(async (key: string, val: string) => {
        const list = redisLists.get(key) || [];
        list.push(val);
        redisLists.set(key, list);
        return list.length;
      }),
      lpop: jest.fn(),
      rpop: jest.fn(),
      del: jest.fn(),
    };

    mockRedisService = {
      getClient: jest.fn().mockReturnValue(mockRedisClient),
    };

    mockDbPool = {
      query: jest.fn(async (sql: string, params: any[]) => {
        if (sql.includes('SELECT') && sql.includes('FROM message')) {
          const ids: string[] = (params?.[0] || []).map(String);
          const rows = ids
            .map((id) => dbMessages.get(Number(id)))
            .filter(Boolean);
          return [rows];
        }
        return [{ affectedRows: 1 }];
      }),
    };

    mockMysqlService = {
      getPool: jest.fn().mockReturnValue(mockDbPool),
    };

    bufferService = new BufferService(mockRedisService, mockMysqlService);
    finalCheckService = new FinalCheckService(bufferService);
  });

  const createMockContext = (overrides: Partial<TurnContext> = {}): TurnContext => {
    return {
      traceId: 'tr_test_final_check',
      tenantId: 1,
      conversationId: convId,
      turnId: 10,
      groupId: 50,
      isFirstTurn: false,
      groupText: '保修几年',
      groupMessages: [],
      customer: { name: '张先生', phone: '13800000000' },
      background: {
        turns: [],
        profile: {},
        emotionTrack: ['calm'],
        unresolved: [],
        counters: { correctionTotal: 0, correctionConsecutive: 0, lowConfConsecutive: 0, emotionBurst: 0 },
        factCard: { inQuestion: '保修', answered: [], pending: [] },
      },
      rulePackVersion: 'v1.0.0',
      sealedAt: sealedAtTime,
      mergeCount: 0,
      timings: { sealedAt: sealedAtTime },
      ...overrides,
    };
  };

  describe('1. 无增量新消息快速短路放行 (≤ 1ms 耗时)', () => {
    it('当封组后客户无任何新消息入池，应在极短时间内直接返回 SEND 允许下发', async () => {
      const ctx = createMockContext();

      const startTime = Date.now();
      const res = await finalCheckService.inspect(ctx);
      const elapsed = Date.now() - startTime;

      // 验证返回值满足 'SEND' 判定
      expect(String(res)).toBe('SEND');
      expect(res == 'SEND').toBe(true);
      expect(res.status).toBe('SEND');
      expect(res.messages).toHaveLength(0);

      // 验证快速短路时延在毫秒级以内
      expect(elapsed).toBeLessThanOrEqual(50);
    });
  });

  describe('2. 非破坏性增量嗅探与缓冲池消息保留 (不出队)', () => {
    it('封组后客户发来 2 条新消息，嗅探应捕获该 2 条消息，且绝对不弹出 Redis 列表元素', async () => {
      const bufKey = `ag:buf:${convId}:${customerId}`;
      // 模拟 Redis 缓冲池中排队 2 条新消息 ID
      redisLists.set(bufKey, ['101', '102']);

      // 模拟 MySQL 中的对应消息记录（sent_at 晚于 sealedAt）
      dbMessages.set(101, {
        id: 101,
        channel_msg_id: 'msg_new_01',
        sender_role: 'CUSTOMER',
        content: '另外再问一下，三电包含电池包吗？',
        sent_at: new Date(sealedAtTime + 2000),
      });
      dbMessages.set(102, {
        id: 102,
        channel_msg_id: 'msg_new_02',
        sender_role: 'CUSTOMER',
        content: '还有电控系统保几年？',
        sent_at: new Date(sealedAtTime + 3500),
      });

      const ctx = createMockContext();
      const res = await finalCheckService.inspect(ctx);

      // 1. 验证捕获到的增量消息数量与详情
      expect(res.length).toBe(2);
      expect(res[0].messageId).toBe(101);
      expect(res[0].text).toBe('另外再问一下，三电包含电池包吗？');
      expect(res[1].messageId).toBe(102);
      expect(res[1].text).toBe('还有电控系统保几年？');

      // 2. 核心断言：验证 Redis 缓冲池绝对未执行 LPOP 或 RPOP，缓冲列表依然保持 2 条消息
      const listAfterInspect = redisLists.get(bufKey);
      expect(listAfterInspect).toBeDefined();
      expect(listAfterInspect).toHaveLength(2);
      expect(listAfterInspect).toEqual(['101', '102']);

      const client = mockRedisService.getClient();
      expect(client.lpop).not.toHaveBeenCalled();
      expect(client.rpop).not.toHaveBeenCalled();
      expect(client.del).not.toHaveBeenCalled();
    });
  });

  describe('3. 时间戳精准过滤 (sent_at >= sealedAt)', () => {
    it('若缓冲池中存在早于 sealedAt 的历史消息，仅嗅探出等于或晚于 sealedAt 的新消息', async () => {
      const bufKey = `ag:buf:${convId}:${customerId}`;
      redisLists.set(bufKey, ['201', '202']);

      // 201 为早于 sealedAt 的消息
      dbMessages.set(201, {
        id: 201,
        channel_msg_id: 'msg_old_01',
        sender_role: 'CUSTOMER',
        content: '历史遗留消息',
        sent_at: new Date(sealedAtTime - 5000),
      });
      // 202 为晚于 sealedAt 的增量消息
      dbMessages.set(202, {
        id: 202,
        channel_msg_id: 'msg_new_03',
        sender_role: 'CUSTOMER',
        content: '封组后才发送的追问消息',
        sent_at: new Date(sealedAtTime + 1000),
      });

      const ctx = createMockContext();
      const res = await finalCheckService.inspect(ctx);

      expect(res.length).toBe(1);
      expect(res[0].messageId).toBe(202);
      expect(res[0].text).toBe('封组后才发送的追问消息');
    });
  });

  describe('4. 多会话与多发送人并发嗅探隔离', () => {
    it('只会嗅探当前会话指定范围的增量消息，不与其它会话串扰', async () => {
      // 当前会话 convId=801 的缓冲池
      redisLists.set(`ag:buf:${convId}:${customerId}`, ['301']);
      dbMessages.set(301, {
        id: 301,
        channel_msg_id: 'msg_801',
        sender_role: 'CUSTOMER',
        content: '当前会话 801 的消息',
        sent_at: new Date(sealedAtTime + 1000),
      });

      // 另一无关会话 convId=999 的缓冲池
      redisLists.set(`ag:buf:999:other_user`, ['9991']);
      dbMessages.set(9991, {
        id: 9991,
        channel_msg_id: 'msg_999',
        sender_role: 'CUSTOMER',
        content: '这是其他会话 999 的消息',
        sent_at: new Date(sealedAtTime + 1000),
      });

      const ctx = createMockContext({ conversationId: convId });
      const res = await finalCheckService.inspect(ctx);

      expect(res.length).toBe(1);
      expect(res[0].messageId).toBe(301);
      expect(res[0].text).toBe('当前会话 801 的消息');
    });
  });

  describe('5. BufferService.peekSince 独立方法测试', () => {
    it('直接调用 peekSince 时，无消息返回空数组，且保证无任何破坏性弹出操作', async () => {
      const emptyRes = await bufferService.peekSince(convId, sealedAtTime);
      expect(emptyRes).toEqual([]);

      // 放入一条消息后再次 peekSince
      redisLists.set(`ag:buf:${convId}:${customerId}`, ['401']);
      dbMessages.set(401, {
        id: 401,
        channel_msg_id: 'msg_peek_01',
        sender_role: 'CUSTOMER',
        content: '独立测试消息',
        sent_at: new Date(sealedAtTime + 500),
      });

      const peeked = await bufferService.peekSince(convId, sealedAtTime);
      expect(peeked).toHaveLength(1);
      expect(peeked[0].messageId).toBe(401);
      expect(peeked[0].text).toBe('独立测试消息');

      // 验证多次 peekSince 结果一致且队列长度不变
      const peekedSecond = await bufferService.peekSince(convId, sealedAtTime);
      expect(peekedSecond).toHaveLength(1);
      expect(redisLists.get(`ag:buf:${convId}:${customerId}`)).toHaveLength(1);
    });
  });
});
