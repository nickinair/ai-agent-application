/**
 * @file pre-send-mic-check.spec.ts
 * @description Task 4.4: 调用渠道下发前一刻的话筒终验防并发单元测试 (附录 C 用例 S7 终验)
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §5.8.1、附录 C 用例 S7
 */

import { FinalCheckService } from '../src/modules/pipeline/final-check.service';
import { BufferService } from '../src/modules/pipeline/buffer.service';
import { StateTransitionService } from '../src/modules/pipeline/state-transition.service';
import { MicrophoneService } from '../src/modules/pipeline/microphone.service';
import { REDIS_KEYS } from '../src/infra/redis/redis.keys';
import type { TurnContext, ChannelAdapter, OutboundMessage } from '../src/contracts';

describe('Task 4.4: 调用渠道下发前一刻的话筒终验防并发测试 (S7 终验)', () => {
  let finalCheckService: FinalCheckService;
  let bufferService: BufferService;
  let stateTransitionService: StateTransitionService;
  let microphoneService: MicrophoneService;
  let mockChannelAdapter: jest.Mocked<ChannelAdapter>;

  let mockRedisService: any;
  let mockMysqlService: any;
  let mockDbPool: any;
  let dbQueries: Array<{ sql: string; params: any[] }>;

  let redisHashes: Map<string, Record<string, string>>;
  let redisLists: Map<string, string[]>;

  const convId = 804;
  const sealedAtTime = 1700000000000;

  beforeEach(() => {
    redisHashes = new Map<string, Record<string, string>>();
    redisLists = new Map<string, string[]>();
    dbQueries = [];

    const mockRedisClient = {
      hgetall: jest.fn(async (key: string) => {
        return redisHashes.get(key) || {};
      }),
      hget: jest.fn(async (key: string, field: string) => {
        return redisHashes.get(key)?.[field] || null;
      }),
      hset: jest.fn(async (key: string, fieldOrObj: any, val?: any) => {
        let hash = redisHashes.get(key) || {};
        if (typeof fieldOrObj === 'object') {
          hash = { ...hash, ...fieldOrObj };
        } else {
          hash[fieldOrObj] = String(val);
        }
        redisHashes.set(key, hash);
      }),
      lrange: jest.fn(async (key: string) => {
        return redisLists.get(key) || [];
      }),
      llen: jest.fn(async (key: string) => {
        return (redisLists.get(key) || []).length;
      }),
      keys: jest.fn(async () => []),
      eval: jest.fn(async () => 0),
    };

    mockRedisService = {
      getClient: jest.fn().mockReturnValue(mockRedisClient),
    };

    mockDbPool = {
      query: jest.fn(async (sql: string, params: any[]) => {
        dbQueries.push({ sql, params });
        return [{ affectedRows: 1 }];
      }),
    };

    mockMysqlService = {
      getPool: jest.fn().mockReturnValue(mockDbPool),
    };

    mockChannelAdapter = {
      channel: 'wecom_group',
      send: jest.fn(async (msg: OutboundMessage) => {
        return { channelMsgId: 'wecom_send_12345' };
      }),
    };

    bufferService = new BufferService(mockRedisService, mockMysqlService);
    stateTransitionService = new StateTransitionService(mockMysqlService);
    microphoneService = new MicrophoneService({} as any, mockMysqlService, mockRedisService);

    finalCheckService = new FinalCheckService(
      bufferService,
      stateTransitionService,
      microphoneService,
      mockChannelAdapter,
      mockMysqlService,
    );
  });

  const createMockContext = (overrides: Partial<TurnContext> = {}): TurnContext => {
    return {
      traceId: 'tr_test_pre_send_check',
      tenantId: 1,
      conversationId: convId,
      turnId: 40,
      groupId: 80,
      isFirstTurn: false,
      groupText: '首保什么时候做？',
      groupMessages: [],
      customer: { name: '孙先生', phone: '13600000000' },
      background: {
        turns: [],
        profile: {},
        emotionTrack: ['calm'],
        unresolved: [],
        counters: { correctionTotal: 0, correctionConsecutive: 0, lowConfConsecutive: 0, emotionBurst: 0 },
        factCard: { inQuestion: '首保', answered: [], pending: [] },
      },
      rulePackVersion: 'v1.0.0',
      sealedAt: sealedAtTime,
      mergeCount: 0,
      reply: {
        text: '新车首保通常在 3 个月或 5000 公里内完成。',
        confidence: 0.95,
      },
      timings: { sealedAt: sealedAtTime },
      ...overrides,
    };
  };

  describe('1. 渠道下发前最后一刻话筒被夺拦截 (preSendCheck & safeSend)', () => {
    it('当 AI 准备下发回复前，员工抢走话筒 (owner=HUMAN)：掐断网络下发，返回 false，ChannelAdapter.send 绝不被调用', async () => {
      // 1. 模拟在生成期间，员工发言抢走话筒
      const micKey = REDIS_KEYS.mic(convId);
      redisHashes.set(micKey, {
        owner: 'HUMAN',
        staffId: 'staff_rep_007',
        since: String(sealedAtTime + 1500),
        epoch: '2',
        reason: 'STAFF_SEIZED',
      });

      const ctx = createMockContext();

      // 2. 核验 preSendCheck 结果
      const check = await finalCheckService.preSendCheck(ctx);
      expect(check.passed).toBe(false);
      expect(check.verdict).toBe('VOID');
      expect(check.reason).toBe('MIC_SEIZED');

      // 3. 执行 safeSend 安全下发尝试
      const sent = await finalCheckService.safeSend(ctx);

      // 4. 关键铁律断言：发送被阻断，未调用网络接口
      expect(sent).toBe(false);
      expect(mockChannelAdapter.send).not.toHaveBeenCalled();
      expect(ctx.finalCheck?.verdict).toBe('VOID');
    });
  });

  describe('2. 作废状态流转与数据库审计落库', () => {
    it('拦截发生时，msg_group 状态跃迁为 VOIDED，turn 表标记 reply_status = VOIDED', async () => {
      const micKey = REDIS_KEYS.mic(convId);
      redisHashes.set(micKey, {
        owner: 'HUMAN',
        staffId: 'staff_rep_007',
        since: String(sealedAtTime + 1500),
        epoch: '2',
        reason: 'STAFF_SEIZED',
      });

      const ctx = createMockContext();
      await finalCheckService.safeSend(ctx);

      // 验证 msg_group 跃迁为 VOIDED
      const groupVoidQuery = dbQueries.find(
        (q) =>
          q.sql.includes('UPDATE msg_group SET status = ?') &&
          q.params[0] === 'VOIDED' &&
          q.params[1] === ctx.groupId &&
          q.params[2] === 'FINAL_CHECKING',
      );
      expect(groupVoidQuery).toBeDefined();

      // 验证 turn 表更新为 reply_status = 'VOIDED'
      const turnVoidQuery = dbQueries.find(
        (q) =>
          q.sql.includes('UPDATE turn SET reply_status') &&
          q.sql.includes('VOIDED') &&
          q.params.includes(ctx.turnId),
      );
      expect(turnVoidQuery).toBeDefined();
    });
  });

  describe('3. 话筒正常安全放行下发', () => {
    it('话筒仍由 BOT 持有时：通过核验并成功调用 ChannelAdapter.send，更新 reply_status = SENT', async () => {
      const micKey = REDIS_KEYS.mic(convId);
      redisHashes.set(micKey, {
        owner: 'BOT',
        staffId: '',
        since: String(sealedAtTime - 5000),
        epoch: '1',
        reason: 'INIT',
      });

      const ctx = createMockContext();

      // 1. preSendCheck 通过
      const check = await finalCheckService.preSendCheck(ctx);
      expect(check.passed).toBe(true);
      expect(check.verdict).toBe('PASS');

      // 2. safeSend 成功调用
      const sent = await finalCheckService.safeSend(ctx);
      expect(sent).toBe(true);
      expect(mockChannelAdapter.send).toHaveBeenCalledTimes(1);
      expect(mockChannelAdapter.send).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: convId,
          text: '新车首保通常在 3 个月或 5000 公里内完成。',
          kind: 'REPLY',
        }),
      );

      // 3. 验证 turn 表状态更新为 reply_status = 'SENT'
      const turnSentQuery = dbQueries.find(
        (q) =>
          q.sql.includes('UPDATE turn SET reply_status') &&
          q.sql.includes('SENT') &&
          q.params[0] === '新车首保通常在 3 个月或 5000 公里内完成。' &&
          q.params[1] === ctx.turnId,
      );
      expect(turnSentQuery).toBeDefined();

      // 4. 验证 msg_group 跃迁为 SENT
      const groupSentQuery = dbQueries.find(
        (q) =>
          q.sql.includes('UPDATE msg_group SET status = ?') &&
          q.params[0] === 'SENT' &&
          q.params[1] === ctx.groupId &&
          q.params[2] === 'FINAL_CHECKING',
      );
      expect(groupSentQuery).toBeDefined();
    });
  });

  describe('4. finalCheck 内置 VOID 短路裁决', () => {
    it('在进入 finalCheck 门禁时话筒已被夺：快速裁决为 VOID，不进行任何重算', async () => {
      const micKey = REDIS_KEYS.mic(convId);
      redisHashes.set(micKey, {
        owner: 'HUMAN',
        staffId: 'staff_rep_008',
        since: String(sealedAtTime + 200),
        epoch: '2',
        reason: 'STAFF_SEIZED',
      });

      const ctx = createMockContext();

      const res = await finalCheckService.finalCheck(ctx);
      expect(String(res)).toBe('VOID');
      expect(res.action).toBe('VOID');
      expect(res.verdict).toBe('VOID');
      expect(res.recomputed).toBe(false);
      expect(ctx.finalCheck?.verdict).toBe('VOID');
    });
  });
});
