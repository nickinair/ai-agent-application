/**
 * @file handoff-locked.spec.ts
 * @description AI 主动转人工锁定机制 (禁止自动接回) 专属单测 (Task 3.6 & 附录 C 用例 S10 协同)
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §6.2 话筒机制、§11.3 角色与转人工协同
 */

import { InboundPipelineService } from '../src/modules/pipeline/inbound-pipeline.service';
import { MicrophoneService } from '../src/modules/pipeline/microphone.service';
import { TimerService } from '../src/modules/pipeline/timer.service';
import type { InboundMessage } from '../src/contracts';
import type { Env } from '../src/config/env';

describe('AI 主动转人工锁定机制测试 (Task 3.6 & is_handoff_locked)', () => {
  let micService: MicrophoneService;
  let inboundService: InboundPipelineService;
  let timerService: TimerService;

  let mockMysqlService: any;
  let mockRedisService: any;
  let mockBufferService: any;
  let mockSealerService: any;
  let mockQueueService: any;

  let mockDbPool: any;
  let mockRedisClient: any;
  let mockTimerQueue: any;
  let dbQueries: { sql: string; params?: any[] }[] = [];
  let redisHashData: Record<string, string> = {};

  let baseEnv: Env;

  beforeEach(() => {
    dbQueries = [];
    redisHashData = {};

    baseEnv = {
      PORT: 3002,
      MYSQL_URL: 'mysql://mock',
      WECOM_BOT_ENABLED: false,
      WECOM_STAFF_MENTIONS: '@客服',
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: 6379,
      REDIS_DB: 0,
      CRM_BASE_URL: 'http://mock-crm.local',
      CRM_SERVICE_TOKEN: 'mock_token',
      CRM_TIMEOUT_MS: 800,
      QUIET_WINDOW_MS: 3000,
      HARD_TIMEOUT_MS: 15000,
      GROUP_MAX_MESSAGES: 5,
      MIC_SEIZE_SCOPE: 'ALL_INTERNAL',
      MIC_RETURN_BY_MENTION_ENABLED: true,
      HUMAN_WAIT_TIMEOUT_MS: 60000,
    };

    mockDbPool = {
      query: jest.fn().mockImplementation(async (sql: string, params?: any[]) => {
        dbQueries.push({ sql, params });
        if (sql.includes('SELECT id FROM conversation')) return [[{ id: 888 }]];
        if (sql.includes('INSERT INTO message')) return [{ insertId: 9001 }];
        if (sql.includes('INSERT INTO conversation')) return [{ insertId: 888 }];
        return [{ affectedRows: 1 }];
      }),
    };

    mockMysqlService = {
      getPool: jest.fn().mockReturnValue(mockDbPool),
    };

    mockRedisClient = {
      get: jest.fn(),
      set: jest.fn().mockResolvedValue('OK'),
      hset: jest.fn().mockImplementation(async (key: string, fieldOrObj: any, val?: any) => {
        if (typeof fieldOrObj === 'object') {
          Object.assign(redisHashData, fieldOrObj);
        } else if (val !== undefined) {
          redisHashData[fieldOrObj] = String(val);
        }
        return 'OK';
      }),
      hgetall: jest.fn().mockImplementation(async () => ({ ...redisHashData })),
      hdel: jest.fn().mockImplementation(async (key: string, field: string) => {
        delete redisHashData[field];
        return 1;
      }),
      eval: jest.fn(),
      del: jest.fn().mockResolvedValue(1),
      incr: jest.fn().mockResolvedValue(1),
    };

    mockRedisService = {
      getClient: jest.fn().mockReturnValue(mockRedisClient),
    };

    mockBufferService = {
      push: jest.fn().mockResolvedValue({ count: 1, isFirst: true, version: 1, epoch: 1 }),
      drain: jest.fn().mockResolvedValue([]),
      getMeta: jest.fn(),
      nonEmptySenders: jest.fn().mockResolvedValue([]),
    };

    mockSealerService = {
      seal: jest.fn().mockResolvedValue({ success: true }),
    };

    mockTimerQueue = {
      add: jest.fn().mockResolvedValue({ id: 'job_hwait' }),
      getJob: jest.fn().mockResolvedValue({ remove: jest.fn().mockResolvedValue(true) }),
    };

    mockQueueService = {
      getQueue: jest.fn().mockReturnValue(mockTimerQueue),
    };

    micService = new MicrophoneService(baseEnv, mockMysqlService, mockRedisService);

    timerService = new TimerService(
      baseEnv,
      mockQueueService,
      mockBufferService,
      mockRedisService,
      mockMysqlService,
      undefined,
      micService,
    );
    timerService.setSealer(mockSealerService);

    inboundService = new InboundPipelineService(
      baseEnv,
      mockMysqlService,
      mockRedisService,
      mockBufferService,
      timerService,
      mockSealerService,
      micService,
    );
  });

  describe('1. lockHandoff 原子转人工锁定与持久化联动', () => {
    it('调用 lockHandoff 时，应通过 Lua 脚本原子写入 is_handoff_locked=1 并同步 MySQL handoff=1', async () => {
      // 模拟 Lua 脚本返回自增后的 epoch = 5
      mockRedisClient.eval.mockResolvedValue(5);

      const status = await micService.lockHandoff(888, 'cs_lead_01', 'COMPLEX_COMPLAINT');

      expect(status.owner).toBe('HUMAN');
      expect(status.epoch).toBe(5);
      expect(status.isHandoffLocked).toBe(true);
      expect(status.reason).toBe('COMPLEX_COMPLAINT');

      // 验证调用了 Lua 脚本
      expect(mockRedisClient.eval).toHaveBeenCalledWith(
        expect.stringContaining('is_handoff_locked'),
        1,
        'ag:mic:888',
        'cs_lead_01',
        expect.any(String),
        'COMPLEX_COMPLAINT',
      );

      // 验证 MySQL 同步更新：mic_owner='HUMAN', handoff=1, handoff_at
      const mysqlSyncQuery = dbQueries.find(
        (q) => q.sql.includes('UPDATE conversation SET mic_owner') && q.sql.includes('handoff = ?'),
      );
      expect(mysqlSyncQuery).toBeDefined();
      expect(mysqlSyncQuery?.params).toContain('HUMAN');
      expect(mysqlSyncQuery?.params).toContain(1); // handoff = 1
      expect(mysqlSyncQuery?.params).toContain(888);
    });
  });

  describe('2. 转人工锁定状态下入站 60s 计时器强力阻断', () => {
    it('当处于转人工锁定 (isHandoffLocked=true) 时，客户首条消息及后续连发均 100% 阻断 60s 接回调度', async () => {
      // 模拟话筒处于主动转人工锁定状态
      jest.spyOn(micService, 'getMicStatus').mockResolvedValue({
        owner: 'HUMAN',
        since: Date.now() - 10000,
        staffId: 'cs_agent_wang',
        reason: 'AI_HANDOFF',
        epoch: 3,
        isHandoffLocked: true,
      });

      const timerSpy = jest.spyOn(timerService, 'scheduleHumanWait');

      // 客户发送首条消息
      mockBufferService.push.mockResolvedValueOnce({
        count: 1,
        version: 1,
        epoch: 1,
        firstAt: Date.now(),
        isFirst: true,
      });

      const msg1: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'chat_group_vip',
        channelMsgId: 'msg_locked_cust_01',
        sender: { role: 'CUSTOMER', channelUserId: 'cust_01' },
        mentions: [],
        type: 'text',
        text: '什么时候能给我退款？',
        sentAt: Date.now(),
      };

      const res1 = await inboundService.onInbound(msg1);
      expect(res1.status).toBe('PROCESSED');
      // 验证首条不调度 60s
      expect(timerSpy).not.toHaveBeenCalled();
      expect(mockTimerQueue.add).not.toHaveBeenCalledWith('hwait', expect.anything(), expect.anything());

      // 客户发送第二条追问消息
      mockBufferService.push.mockResolvedValueOnce({
        count: 2,
        version: 2,
        epoch: 1,
        firstAt: Date.now() - 5000,
        isFirst: false,
      });

      const msg2: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'chat_group_vip',
        channelMsgId: 'msg_locked_cust_02',
        sender: { role: 'CUSTOMER', channelUserId: 'cust_01' },
        mentions: [],
        type: 'text',
        text: '再不回电话我就拨打12315了！',
        sentAt: Date.now(),
      };

      const res2 = await inboundService.onInbound(msg2);
      expect(res2.status).toBe('PROCESSED');
      // 连发追问依然绝不调度
      expect(timerSpy).not.toHaveBeenCalled();
    });
  });

  describe('3. 60s 延时任务到期触发时的防接回安全门禁', () => {
    it('即使存在历史 60s 任务到期触发，若话筒已处于转人工锁定，安全忽略接回，绝不封组与交还 BOT', async () => {
      jest.spyOn(micService, 'getMicStatus').mockResolvedValue({
        owner: 'HUMAN',
        since: Date.now() - 65000,
        staffId: 'cs_agent_wang',
        reason: 'AI_HANDOFF',
        epoch: 3,
        isHandoffLocked: true,
      });

      const returnSpy = jest.spyOn(micService, 'returnToBot');

      // 模拟看门狗任务到期
      await timerService.handleTimerJob({
        data: {
          type: 'hwait',
          convId: 888,
          senderId: 'cust_01',
          micEpoch: 3,
        },
      } as any);

      // 验证绝不调用 returnToBot
      expect(returnSpy).not.toHaveBeenCalled();
      // 验证绝不触发封组 (机器人闭嘴)
      expect(mockSealerService.seal).not.toHaveBeenCalled();
    });
  });

  describe('4. 非强制交还被拒与客服显式 @机器人 解锁交还协同', () => {
    it('处于锁定状态时，普通交还 returnToBot(force=false) 被 Lua 脚本直接拒绝 (HANDOFF_LOCKED)', async () => {
      // 模拟 Redis Lua 脚本拒绝返回: [0, currentEpoch=3, "HANDOFF_LOCKED"]
      mockRedisClient.eval.mockResolvedValue([0, 3, 'HANDOFF_LOCKED']);

      const res = await micService.returnToBot(888, 'HUMAN_TIMEOUT', false);

      expect(res.success).toBe(false);
      expect(res.reason).toBe('HANDOFF_LOCKED');
      expect(res.epoch).toBe(3);
    });

    it('客服在群内显式 @机器人 时，调用 returnByMention (force=true) 成功强制解锁并交还 BOT', async () => {
      // 模拟强制交还成功: [1, newEpoch=4, "RETURNED"]
      mockRedisClient.eval.mockResolvedValue([1, 4, 'RETURNED']);

      const res = await micService.returnByMention(888, 'cs_agent_wang');

      expect(res.success).toBe(true);
      expect(res.reason).toBe('RETURNED');
      expect(res.epoch).toBe(4);

      // 验证向 Lua 脚本传入了 force="1"
      expect(mockRedisClient.eval).toHaveBeenCalledWith(
        expect.stringContaining('isLocked == "1" and ARGV[3] == "0"'),
        1,
        'ag:mic:888',
        expect.any(String),
        'MENTION_RETURN',
        '1', // force = 1
      );
    });
  });
});
