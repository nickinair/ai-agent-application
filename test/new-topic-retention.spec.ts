/**
 * @file new-topic-retention.spec.ts
 * @description Task 4.3: 换题新消息保留在缓冲池逻辑单元测试 (附录 C 用例 S6)
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §5.8.1、附录 C 用例 S6
 */

import { FinalCheckService, NEW_TOPIC_REGEX } from '../src/modules/pipeline/final-check.service';
import { BufferService } from '../src/modules/pipeline/buffer.service';
import { StateTransitionService } from '../src/modules/pipeline/state-transition.service';
import { REDIS_KEYS } from '../src/infra/redis/redis.keys';
import type { TurnContext } from '../src/contracts';

describe('Task 4.3: 换题新消息保留在缓冲池逻辑测试 (附录 C 用例 S6)', () => {
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

  const convId = 803;
  const customerId = 'cust_vip_003';
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
      del: jest.fn(async (key: string) => {
        const existed = redisLists.has(key);
        redisLists.delete(key);
        return existed ? 1 : 0;
      }),
      eval: jest.fn(async (script: string, numkeys: number, ...args: any[]) => {
        // drain 脚本模拟
        if (script.includes('lrange') && script.includes('del')) {
          const bufKey = args[0];
          const metaKey = args[1];
          const ids = redisLists.get(bufKey) || [];
          redisLists.delete(bufKey);
          const hash = redisHashes.get(metaKey) || {};
          hash.count = '0';
          hash.epoch = String((parseInt(hash.epoch || '1', 10)) + 1);
          redisHashes.set(metaKey, hash);
          return ids;
        }
        return [];
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
        return [{ affectedRows: 1, insertId: 7002 }];
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
      traceId: 'tr_test_new_topic',
      tenantId: 1,
      conversationId: convId,
      turnId: 30,
      groupId: 70, // 组 A
      isFirstTurn: false,
      groupText: '延保包含三电吗？',
      groupMessages: [
        {
          messageId: 601,
          channelMsgId: 'cmsg_601',
          senderRole: 'CUSTOMER',
          text: '延保包含三电吗？',
          sentAt: sealedAtTime - 2000,
        },
      ],
      customer: { name: '赵先生', phone: '13700000000' },
      background: {
        turns: [],
        profile: {},
        emotionTrack: ['calm'],
        unresolved: [],
        counters: { correctionTotal: 0, correctionConsecutive: 0, lowConfConsecutive: 0, emotionBurst: 0 },
        factCard: { inQuestion: '延保范围', answered: [], pending: [] },
      },
      rulePackVersion: 'v1.0.0',
      sealedAt: sealedAtTime,
      mergeCount: 0,
      timings: { sealedAt: sealedAtTime },
      ...overrides,
    };
  };

  describe('1. 换题规则词典判定 matchRelation & NEW_TOPIC_REGEX', () => {
    it('精准识别换题前缀为 NEW_TOPIC', () => {
      expect(finalCheckService.matchRelation('延保包含三电吗', '另外保养多少钱？')).toBe('NEW_TOPIC');
      expect(finalCheckService.matchRelation('延保包含三电吗', '顺便问下洗车服务')).toBe('NEW_TOPIC');
      expect(finalCheckService.matchRelation('延保包含三电吗', '还有就是首保免费吗')).toBe('NEW_TOPIC');
      expect(finalCheckService.matchRelation('延保包含三电吗', '换个问题，车机怎么升级')).toBe('NEW_TOPIC');
      expect(finalCheckService.matchRelation('延保包含三电吗', '换个话题，续航怎么样')).toBe('NEW_TOPIC');
      expect(finalCheckService.matchRelation('延保包含三电吗', '再问下一个月的费用')).toBe('NEW_TOPIC');
      expect(finalCheckService.matchRelation('延保包含三电吗', '咨询下别的事，轮胎怎么保')).toBe('NEW_TOPIC');
      expect(finalCheckService.matchRelation('延保包含三电吗', '对了，我想问下提车日期')).toBe('NEW_TOPIC');
    });

    it('纠正与否定词优先级高于换题词', () => {
      // 包含否定纠正特征时，必须以纠正优先 (CORRECT)
      expect(finalCheckService.matchRelation('延保包含三电吗', '不对，另外一个我不要')).toBe('CORRECT');
      expect(finalCheckService.matchRelation('延保包含三电吗', '搞错了，我问的不是保养')).toBe('CORRECT');
    });

    it('常规顺承追问归为 CONTINUE', () => {
      expect(finalCheckService.matchRelation('延保包含三电吗', '价格呢？')).toBe('CONTINUE');
      expect(finalCheckService.matchRelation('延保包含三电吗', '好的知道了')).toBe('CONTINUE');
    });
  });

  describe('2. 用例 S6: 末检判 NEW_TOPIC，组 A 照发，新消息完整保留缓冲池', () => {
    it('组 A 理解生成中客户发送“另外保养多少钱”：末检返回 SEND (verdict=NEW_TOPIC)，组 A 内容不变，新消息在缓冲池中零出队零丢失', async () => {
      // 1. 模拟组 A 生成期间客户发来换题新消息
      const bufKey = REDIS_KEYS.buffer(convId, customerId);
      const metaKey = REDIS_KEYS.bufferMeta(convId, customerId);
      redisLists.set(bufKey, ['701']);
      redisHashes.set(metaKey, { count: '1', version: '2', epoch: '1' });

      dbMessages.set(701, {
        id: 701,
        channel_msg_id: 'cmsg_701',
        sender_role: 'CUSTOMER',
        content: '另外保养多少钱？',
        sent_at: new Date(sealedAtTime + 1000),
      });

      const ctx = createMockContext({
        senderId: customerId,
        groupId: 70, // 组 A
        groupText: '延保包含三电吗？',
      } as any);

      // 2. 触发第六关末检
      const res = await finalCheckService.finalCheck(ctx);

      // 3. 断言结论为 SEND，且裁决为 NEW_TOPIC
      expect(String(res)).toBe('SEND');
      expect(res.action).toBe('SEND');
      expect(res.verdict).toBe('NEW_TOPIC');
      expect(res.recomputed).toBe(false);

      // 4. 断言组 A 上下文完全未被改动
      expect(ctx.groupText).toBe('延保包含三电吗？');
      expect(ctx.mergeCount).toBe(0);
      expect(ctx.groupMessages.length).toBe(1);

      // 5. 核心铁律断言：Redis 缓冲池中的换题消息完好无损保留！
      expect(redisLists.get(bufKey)).toEqual(['701']);
      expect(redisHashes.get(metaKey)?.count).toBe('1');

      // 6. 验证无任何向 UNDERSTANDING 倒退的状态变更 SQL
      const backwardStatusQuery = dbQueries.find(
        (q) => q.sql.includes('UPDATE msg_group SET status = ?') && q.params[0] === 'UNDERSTANDING',
      );
      expect(backwardStatusQuery).toBeUndefined();

      // 7. 验证无任何针对消息 701 的 group_id 更新 SQL（不得并入组 A）
      const updateMsgGroupQuery = dbQueries.find(
        (q) => q.sql.includes('UPDATE message SET group_id = ?') && q.params[0] === 70,
      );
      expect(updateMsgGroupQuery).toBeUndefined();
    });
  });

  describe('3. 跨组生命周期联动: 组 A 完结后，缓冲池留存消息独立封为组 B', () => {
    it('组 A 发送完毕后，BufferService.drain 提取留存消息，并可成功独立封组', async () => {
      // 1. 模拟缓冲池留存的换题消息
      const bufKey = REDIS_KEYS.buffer(convId, customerId);
      const metaKey = REDIS_KEYS.bufferMeta(convId, customerId);
      redisLists.set(bufKey, ['701']);
      redisHashes.set(metaKey, { count: '1', version: '2', epoch: '1' });

      // 2. 组 A 发送完毕，后续轮次触发提取封组 (drain)
      const drainedIds = await bufferService.drain(convId, customerId);

      // 3. 断言精确取出了留存的 701 消息，且此时缓冲池被清空，epoch 推进
      expect(drainedIds).toEqual(['701']);
      expect(redisLists.has(bufKey)).toBe(false);
      expect(redisHashes.get(metaKey)?.count).toBe('0');
      expect(redisHashes.get(metaKey)?.epoch).toBe('2');
    });
  });
});
