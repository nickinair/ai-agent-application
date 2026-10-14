/**
 * @file merge-and-recompute.spec.ts
 * @description Task 4.2: 增量消息接关规则判定与单次合并重算驱动单元测试 (S4, S5)
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §5.8.1、附录 C 用例 S4, S5
 */

import { FinalCheckService, CORRECTION_REGEX } from '../src/modules/pipeline/final-check.service';
import { BufferService } from '../src/modules/pipeline/buffer.service';
import { StateTransitionService } from '../src/modules/pipeline/state-transition.service';
import { REDIS_KEYS } from '../src/infra/redis/redis.keys';
import type { TurnContext, MessageRef } from '../src/contracts';

describe('Task 4.2: 增量消息接关规则判定与单次合并重算驱动测试 (S4, S5)', () => {
  let finalCheckService: FinalCheckService;
  let bufferService: BufferService;
  let stateTransitionService: StateTransitionService;

  let mockRedisService: any;
  let mockMysqlService: any;
  let mockDbPool: any;
  let dbQueries: Array<{ sql: string; params: any[] }>;

  let redisLists: Map<string, string[]>;
  let redisHashes: Map<string, Record<string, string>>;
  let dbMessages: Map<number, any>;

  const convId = 802;
  const customerId = 'cust_vip_002';
  const sealedAtTime = 1700000000000;

  beforeEach(() => {
    redisLists = new Map<string, string[]>();
    redisHashes = new Map<string, Record<string, string>>();
    dbMessages = new Map<number, any>();
    dbQueries = [];

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
      hget: jest.fn(async (key: string, field: string) => {
        return redisHashes.get(key)?.[field] || null;
      }),
      hset: jest.fn(async (key: string, field: string, val: any) => {
        const hash = redisHashes.get(key) || {};
        hash[field] = String(val);
        redisHashes.set(key, hash);
      }),
      eval: jest.fn(async (script: string, numkeys: number, ...args: any[]) => {
        // 模拟 takeInto 的 LREM + count 扣减 lua 脚本
        if (script.includes('lrem')) {
          const bufKey = args[0];
          const metaKey = args[1];
          const idsToRemove = args.slice(2).map(String);
          let list = redisLists.get(bufKey) || [];
          let removedTotal = 0;
          for (const id of idsToRemove) {
            const beforeLen = list.length;
            list = list.filter((item) => item !== id);
            removedTotal += beforeLen - list.length;
          }
          redisLists.set(bufKey, list);

          if (removedTotal > 0) {
            const hash = redisHashes.get(metaKey) || {};
            const curCount = parseInt(hash.count || '0', 10);
            hash.count = String(Math.max(0, curCount - removedTotal));
            redisHashes.set(metaKey, hash);
          }
          return removedTotal;
        }
        return 0;
      }),
    };

    mockRedisService = {
      getClient: jest.fn().mockReturnValue(mockRedisClient),
    };

    mockDbPool = {
      query: jest.fn(async (sql: string, params: any[]) => {
        dbQueries.push({ sql, params });
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
    stateTransitionService = new StateTransitionService(mockMysqlService);
    finalCheckService = new FinalCheckService(bufferService, stateTransitionService);
  });

  const createMockContext = (overrides: Partial<TurnContext> = {}): TurnContext => {
    return {
      traceId: 'tr_test_merge_recompute',
      tenantId: 1,
      conversationId: convId,
      turnId: 20,
      groupId: 60,
      isFirstTurn: false,
      groupText: '保修期多久',
      groupMessages: [
        {
          messageId: 101,
          channelMsgId: 'msg_101',
          senderRole: 'CUSTOMER',
          text: '保修期多久',
          sentAt: sealedAtTime - 2000,
        },
      ],
      customer: { name: '李女士', phone: '13900000000' },
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

  describe('1. 规则词典判定 matchRelation & CORRECTION_REGEX', () => {
    it('应精准识别各类否定/纠正前缀为 CORRECT', () => {
      expect(finalCheckService.matchRelation('保修期多久', '不对，我问的是整车延保')).toBe('CORRECT');
      expect(finalCheckService.matchRelation('保修期多久', '不是，我说的是发动机')).toBe('CORRECT');
      expect(finalCheckService.matchRelation('保修期多久', '搞错了，是问界M7不是M5')).toBe('CORRECT');
      expect(finalCheckService.matchRelation('保修期多久', '问的是三电延保')).toBe('CORRECT');
      expect(finalCheckService.matchRelation('保修期多久', '我说的是另外一个')).toBe('CORRECT');
      expect(finalCheckService.matchRelation('保修期多久', '你理解错了')).toBe('CORRECT');
      expect(finalCheckService.matchRelation('保修期多久', '错啦，别答这个')).toBe('CORRECT');
      expect(finalCheckService.matchRelation('保修期多久', '不是这个意思')).toBe('CORRECT');
    });

    it('常规疑问或追问不得误判为 CORRECT', () => {
      expect(finalCheckService.matchRelation('保修期多久', '价格是多少呢')).toBe('CONTINUE');
      expect(finalCheckService.matchRelation('保修期多久', '是不是免费的')).toBe('CONTINUE');
      expect(finalCheckService.matchRelation('保修期多久', '能不能送保养')).toBe('CONTINUE');
      expect(finalCheckService.matchRelation('保修期多久', '好的谢谢')).toBe('CONTINUE');
    });
  });

  describe('2. 用例 S4: 首次纠正合并入组并重算 (mergeCount < 1)', () => {
    it('封组后收到纠正消息：并入当前组、追加 groupText、mergeCount 变 1、状态退回 UNDERSTANDING，并返回 RECOMPUTE', async () => {
      // 1. 模拟封组后缓冲池进了一条纠正新消息
      const bufKey = REDIS_KEYS.buffer(convId, customerId);
      const metaKey = REDIS_KEYS.bufferMeta(convId, customerId);
      redisLists.set(bufKey, ['201']);
      redisHashes.set(metaKey, { count: '1' });

      dbMessages.set(201, {
        id: 201,
        channel_msg_id: 'cmsg_201',
        sender_role: 'CUSTOMER',
        content: '不对，我问的是整车延保',
        sent_at: new Date(sealedAtTime + 500),
      });

      const ctx = createMockContext({
        senderId: customerId,
        mergeCount: 0,
      } as any);

      // 2. 执行末检
      const res = await finalCheckService.finalCheck(ctx);

      // 3. 断言返回值
      expect(String(res)).toBe('RECOMPUTE');
      expect(res.action).toBe('RECOMPUTE');
      expect(res.verdict).toBe('CORRECT');
      expect(res.recomputed).toBe(true);

      // 4. 断言上下文变更
      expect(ctx.mergeCount).toBe(1);
      expect(ctx.groupText).toBe('保修期多久\n不对，我问的是整车延保');
      expect(ctx.groupMessages.length).toBe(2);
      expect(ctx.groupMessages[1].text).toBe('不对，我问的是整车延保');

      // 5. 验证状态机流转：msg_group 从 FINAL_CHECKING 跃迁至 UNDERSTANDING
      const stateTransitionQuery = dbQueries.find(
        (q) =>
          q.sql.includes('UPDATE msg_group SET status = ?') &&
          q.params[0] === 'UNDERSTANDING' &&
          q.params[1] === ctx.groupId &&
          q.params[2] === 'FINAL_CHECKING',
      );
      expect(stateTransitionQuery).toBeDefined();

      // 6. 验证缓冲池出队与 DB 关联
      // Redis 消息已被清除
      expect(redisLists.get(bufKey)?.length).toBe(0);
      expect(redisHashes.get(metaKey)?.count).toBe('0');

      // MySQL message.group_id 关联
      const msgUpdateQuery = dbQueries.find(
        (q) => q.sql.includes('UPDATE message SET group_id = ?') && q.params[0] === ctx.groupId,
      );
      expect(msgUpdateQuery).toBeDefined();

      // MySQL msg_group 字段累加
      const groupUpdateQuery = dbQueries.find((q) => q.sql.includes('UPDATE msg_group') && q.sql.includes('message_count'));
      expect(groupUpdateQuery).toBeDefined();
    });
  });

  describe('3. 用例 S5: 重算达到上限不再合并照常发出 (mergeCount >= 1)', () => {
    it('当 mergeCount 已为 1 时，再次收到纠正消息：熔断禁止再次合并，返回 SEND，新消息完整保留在缓冲池', async () => {
      // 1. 模拟缓冲池有一条再次纠正的消息
      const bufKey = REDIS_KEYS.buffer(convId, customerId);
      const metaKey = REDIS_KEYS.bufferMeta(convId, customerId);
      redisLists.set(bufKey, ['301']);
      redisHashes.set(metaKey, { count: '1' });

      dbMessages.set(301, {
        id: 301,
        channel_msg_id: 'cmsg_301',
        sender_role: 'CUSTOMER',
        content: '搞错了，是三年不是五年',
        sent_at: new Date(sealedAtTime + 800),
      });

      // 上下文已经历过 1 次重算 (mergeCount = 1)
      const ctx = createMockContext({
        senderId: customerId,
        mergeCount: 1,
        groupText: '保修期多久\n不对，我问的是整车延保',
      } as any);

      // 2. 执行末检
      const res = await finalCheckService.finalCheck(ctx);

      // 3. 断言返回值直接为 SEND（放行发出原回复）
      expect(String(res)).toBe('SEND');
      expect(res.action).toBe('SEND');
      expect(res.verdict).toBe('CORRECT');
      expect(res.recomputed).toBe(false);

      // 4. 断言 groupText 和 mergeCount 未被修改
      expect(ctx.mergeCount).toBe(1);
      expect(ctx.groupText).toBe('保修期多久\n不对，我问的是整车延保');
      expect(ctx.groupMessages.length).toBe(1);

      // 5. 验证未触发任何 UNDERSTANDING 状态倒退
      const transitionQuery = dbQueries.find(
        (q) => q.sql.includes('UPDATE msg_group SET status = ?') && q.params[0] === 'UNDERSTANDING',
      );
      expect(transitionQuery).toBeUndefined();

      // 6. 验证新消息完好无损地保留在 Redis 缓冲池中（等待下一组封组消费）
      expect(redisLists.get(bufKey)?.length).toBe(1);
      expect(redisLists.get(bufKey)?.[0]).toBe('301');
      expect(redisHashes.get(metaKey)?.count).toBe('1');
    });
  });

  describe('4. 非纠正消息正常放行并保留缓冲池', () => {
    it('封组后客户发送常规追问（非纠正）：直接返回 SEND，消息留存缓冲池', async () => {
      const bufKey = REDIS_KEYS.buffer(convId, customerId);
      const metaKey = REDIS_KEYS.bufferMeta(convId, customerId);
      redisLists.set(bufKey, ['401']);
      redisHashes.set(metaKey, { count: '1' });

      dbMessages.set(401, {
        id: 401,
        channel_msg_id: 'cmsg_401',
        sender_role: 'CUSTOMER',
        content: '价格一般在多少左右？',
        sent_at: new Date(sealedAtTime + 600),
      });

      const ctx = createMockContext({
        senderId: customerId,
        mergeCount: 0,
      } as any);

      const res = await finalCheckService.finalCheck(ctx);

      expect(String(res)).toBe('SEND');
      expect(res.action).toBe('SEND');
      expect(res.recomputed).toBe(false);

      // 缓冲池未出队
      expect(redisLists.get(bufKey)?.length).toBe(1);
      expect(ctx.mergeCount).toBe(0);
    });
  });

  describe('5. BufferService.takeInto 物理出队与 DB 映射', () => {
    it('成功将新消息出队、扣减 count，并更新数据库 message 与 msg_group', async () => {
      const bufKey = REDIS_KEYS.buffer(convId, customerId);
      const metaKey = REDIS_KEYS.bufferMeta(convId, customerId);
      redisLists.set(bufKey, ['501', '502']);
      redisHashes.set(metaKey, { count: '2' });

      const newMsgs: MessageRef[] = [
        {
          messageId: 501,
          channelMsgId: 'cmsg_501',
          senderRole: 'CUSTOMER',
          text: '纠正文本一',
          sentAt: Date.now(),
        },
      ];

      await bufferService.takeInto(convId, 60, newMsgs, customerId);

      // 验证 Redis 消息出队 501，剩余 502
      expect(redisLists.get(bufKey)).toEqual(['502']);
      expect(redisHashes.get(metaKey)?.count).toBe('1');

      // 验证 DB 更新
      const msgQuery = dbQueries.find(
        (q) => q.sql.includes('UPDATE message SET group_id = ?') && q.params[0] === 60,
      );
      expect(msgQuery).toBeDefined();
      expect(msgQuery?.params[1]).toEqual([501]);

      const groupQuery = dbQueries.find(
        (q) => q.sql.includes('UPDATE msg_group') && q.params[0] === 1,
      );
      expect(groupQuery).toBeDefined();
    });
  });
});
