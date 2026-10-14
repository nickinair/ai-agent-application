/**
 * @file phase3-integration.spec.ts
 * @description 企微双轨人机协同与话筒闭环端到端集成测试 (S1~S3, S7~S9, S21, @机器人显式交还)
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §6.2、附录 C (S1~S3, S7~S9, S21)
 */

import { InboundPipelineService } from '../src/modules/pipeline/inbound-pipeline.service';
import { MicrophoneService } from '../src/modules/pipeline/microphone.service';
import { TimerService } from '../src/modules/pipeline/timer.service';
import type { InboundMessage } from '../src/contracts';
import type { Env } from '../src/config/env';

describe('企微双轨人机协同与话筒闭环集成测试 (Phase 3 Integration)', () => {
  let inboundService: InboundPipelineService;
  let micService: MicrophoneService;
  let timerService: TimerService;

  let mockMysqlService: any;
  let mockRedisService: any;
  let mockBufferService: any;
  let mockSealerService: any;
  let mockQueueService: any;
  let mockStateTransitionService: any;

  let mockDbPool: any;
  let mockRedisClient: any;
  let mockTimerQueue: any;

  let baseEnv: Env;

  beforeEach(() => {
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
        if (sql.includes('SELECT id FROM conversation')) return [[{ id: 888 }]];
        if (sql.includes('INSERT INTO message')) return [{ insertId: 9001 }];
        if (sql.includes('INSERT INTO conversation')) return [{ insertId: 888 }];
        if (sql.includes('INSERT INTO msg_group')) return [{ insertId: 7001 }];
        if (sql.includes('INSERT INTO turn')) return [{ insertId: 6001 }];
        if (sql.includes('FROM msg_group') && sql.includes('status')) {
          return [[{ status: 'UNDERSTANDING', turn_id: 6001 }]];
        }
        if (sql.includes('FROM message') && sql.includes('content')) {
          return [[{ content: '延保多少钱' }, { content: '保修范围呢' }]];
        }
        return [{ affectedRows: 1 }];
      }),
    };

    mockMysqlService = {
      getPool: jest.fn().mockReturnValue(mockDbPool),
    };

    mockRedisClient = {
      get: jest.fn(),
      set: jest.fn().mockResolvedValue('OK'),
      hset: jest.fn().mockResolvedValue('OK'),
      hgetall: jest.fn().mockResolvedValue({}),
      eval: jest.fn(),
      del: jest.fn().mockResolvedValue(1),
      incr: jest.fn().mockResolvedValue(1),
    };

    mockRedisService = {
      getClient: jest.fn().mockReturnValue(mockRedisClient),
    };

    mockBufferService = {
      push: jest.fn(),
      drain: jest.fn(),
      nonEmptySenders: jest.fn().mockResolvedValue([]),
    };

    mockSealerService = {
      seal: jest.fn().mockResolvedValue({ success: true }),
    };

    mockTimerQueue = {
      add: jest.fn().mockResolvedValue({ id: 'job_wait' }),
      getJob: jest.fn().mockResolvedValue({ remove: jest.fn().mockResolvedValue(true) }),
    };

    mockQueueService = {
      getQueue: jest.fn().mockReturnValue(mockTimerQueue),
      createWorker: jest.fn(),
    };

    mockStateTransitionService = {
      transition: jest.fn().mockResolvedValue({ success: true }),
    };

    micService = new MicrophoneService(baseEnv, mockMysqlService, mockRedisService);
    timerService = new TimerService(
      baseEnv,
      mockQueueService,
      mockBufferService,
      mockRedisService,
      mockMysqlService,
      mockStateTransitionService,
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
      mockStateTransitionService,
    );
  });

  describe('1. 缓冲池与封组调度 (S1 ~ S3 验收)', () => {
    it('S1 验收: 客户首条消息入池预约 3s 静默计时器，静默到期后触发封组 (QUIET)', async () => {
      mockRedisClient.hgetall.mockResolvedValue({ owner: 'BOT', epoch: '1' });
      mockBufferService.push.mockResolvedValue({
        count: 1,
        version: 1,
        epoch: 1,
        firstAt: Date.now(),
        isFirst: true,
      });

      const msg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'group_car_01',
        channelMsgId: 'msg_cust_01',
        sender: { role: 'CUSTOMER', channelUserId: 'wm_cust_001' },
        mentions: [],
        type: 'text',
        text: '咨询一下延保',
        sentAt: Date.now(),
      };

      const res = await inboundService.onInbound(msg);

      expect(res.status).toBe('PROCESSED');
      expect(res.sealedDirectly).toBe(false);
      // 验证预约了静默计时器
      expect(mockTimerQueue.add).toHaveBeenCalledWith(
        'quiet',
        expect.objectContaining({ convId: 888, senderId: 'wm_cust_001', version: 1 }),
        expect.objectContaining({ delay: 3000 }),
      );
    });

    it('S2 验收: 客户连续发送第 5 条消息，达到阈值立即强行封组 (COUNT)', async () => {
      mockRedisClient.hgetall.mockResolvedValue({ owner: 'BOT', epoch: '1' });
      mockBufferService.push.mockResolvedValue({
        count: 5,
        version: 5,
        epoch: 1,
        firstAt: Date.now() - 2000,
        isFirst: false,
      });

      const msg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'group_car_01',
        channelMsgId: 'msg_cust_05',
        sender: { role: 'CUSTOMER', channelUserId: 'wm_cust_001' },
        mentions: [],
        type: 'text',
        text: '有人在吗？',
        sentAt: Date.now(),
      };

      const res = await inboundService.onInbound(msg);

      expect(res.status).toBe('PROCESSED');
      expect(res.sealedDirectly).toBe(true);
      expect(mockSealerService.seal).toHaveBeenCalledWith(888, 'wm_cust_001', 'COUNT');
    });

    it('S3 验收: 熔断计时器到期 (15s)，无论是否静默均强行触发封组 (HARD)', async () => {
      mockBufferService.getMeta = jest.fn().mockResolvedValue({ count: 3, epoch: 1 });

      await timerService.handleTimerJob({
        data: {
          type: 'hard',
          convId: 888,
          senderId: 'wm_cust_001',
          epoch: 1,
        },
      } as any);

      expect(mockSealerService.seal).toHaveBeenCalledWith(888, 'wm_cust_001', 'HARD');
    });
  });

  describe('2. 员工抢占话筒与在途作废 (S7 验收)', () => {
    it('S7 验收: 员工在群内发言抢话筒，当前在途组 (UNDERSTANDING) 应被原子作废为 VOIDED 并清理锁', async () => {
      // 模拟 Redis 中存在在途任务
      mockRedisClient.hgetall.mockImplementation(async (key: string) => {
        if (key === 'ag:inflight:888') {
          return { groupId: '7001', convId: '888', traceId: 'tr_123', startedAt: '1000' };
        }
        return { owner: 'BOT', epoch: '1' };
      });

      // 模拟 Lua 抢占成功: [changed=1, prev="BOT", now="HUMAN", newEpoch=2, staff="staff_007", reason="STAFF_SEIZED"]
      mockRedisClient.eval.mockResolvedValue([1, 'BOT', 'HUMAN', 2, 'staff_007', 'STAFF_SEIZED']);

      const msg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'group_car_01',
        channelMsgId: 'msg_staff_01',
        sender: { role: 'STAFF_CS', channelUserId: 'staff_007' },
        mentions: [],
        type: 'text',
        text: '您好，客户我来接待！',
        sentAt: Date.now(),
      };

      const res = await inboundService.onInbound(msg);

      expect(res.status).toBe('STAFF_HANDLED');
      // 验证触发在途组作废流转
      expect(mockStateTransitionService.transition).toHaveBeenCalledWith(
        'GROUP',
        '7001',
        'UNDERSTANDING',
        'VOIDED',
        expect.objectContaining({
          tenantId: 1,
          operatorType: 'STAFF',
          reason: 'MIC_SEIZED',
        }),
      );
      // 验证清理在途与会话互斥锁
      expect(mockRedisClient.del).toHaveBeenCalledWith('ag:inflight:888');
      expect(mockRedisClient.del).toHaveBeenCalledWith('ag:lock:conv:888');
    });
  });

  describe('3. 员工抢跑结清缓冲池归档 (S8 验收)', () => {
    it('S8 验收: 客服发言抢跑解答，客户未处理的缓冲池消息就地封组归档 (ARCHIVED) 且记录人工轮次', async () => {
      mockRedisClient.hgetall.mockResolvedValue({});
      mockRedisClient.eval.mockResolvedValue([1, 'BOT', 'HUMAN', 2, 'staff_007', 'STAFF_SEIZED']);

      // 模拟缓冲池中有客户积累的 2 条消息
      mockBufferService.nonEmptySenders.mockResolvedValue(['wm_cust_001']);
      mockBufferService.drain.mockResolvedValue([101, 102]);

      const msg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'group_car_01',
        channelMsgId: 'msg_staff_ans',
        sender: { role: 'STAFF_CS', channelUserId: 'staff_007' },
        mentions: [],
        type: 'text',
        text: '整车延保一年2880元，包含三电和核心底盘件',
        sentAt: Date.now(),
      };

      await inboundService.onInbound(msg);

      // 1. 验证缓冲池消息被抽空 (drain)
      expect(mockBufferService.drain).toHaveBeenCalledWith(888, 'wm_cust_001');

      // 2. 验证创建了封组归档记录 (status = ARCHIVED, seal_reason = HUMAN_REPLIED)
      expect(mockDbPool.query).toHaveBeenCalledWith(
        expect.stringContaining("status, seal_reason, message_count, merged_text"),
        expect.arrayContaining([1, 888, 'wm_cust_001', 2, '延保多少钱\n保修范围呢']),
      );

      // 3. 验证向 turn 表插入人工轮次 (responder = 'HUMAN')
      expect(mockDbPool.query).toHaveBeenCalledWith(
        expect.stringContaining("status, responder, reply_text, reply_status"),
        expect.arrayContaining([1, 888, '整车延保一年2880元，包含三电和核心底盘件']),
      );
    });
  });

  describe('4. 话筒在人工手中与 60s 看门狗超时自动接回 (S9 验收)', () => {
    it('S9 验收 (入站分流): 当话筒在 HUMAN 手中，客户发消息不触发 3s 静默，预约 60s 人工等待任务', async () => {
      // 话筒为 HUMAN
      mockRedisClient.hgetall.mockResolvedValue({
        owner: 'HUMAN',
        epoch: '2',
        staffId: 'staff_007',
        is_handoff_locked: '0',
      });
      mockBufferService.push.mockResolvedValue({ count: 1, version: 1, epoch: 1 });

      const msg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'group_car_01',
        channelMsgId: 'msg_cust_late',
        sender: { role: 'CUSTOMER', channelUserId: 'wm_cust_001' },
        mentions: [],
        type: 'text',
        text: '客服还在吗？',
        sentAt: Date.now(),
      };

      const res = await inboundService.onInbound(msg);

      expect(res.status).toBe('PROCESSED');
      expect(res.sealedDirectly).toBe(false);
      // 验证未调用静默计时器的普通逻辑
      expect(mockTimerQueue.add).toHaveBeenCalledWith(
        'hwait',
        expect.objectContaining({
          convId: 888,
          senderId: 'wm_cust_001',
          micEpoch: 2,
        }),
        expect.objectContaining({
          delay: 60000,
        }),
      );
    });

    it('S9 验收 (超时到期): 60s 后人工未回复，看门狗自动将话筒交还 BOT 并立即封组', async () => {
      // 模拟当前 Redis 中话筒仍为 HUMAN，epoch 匹配且未被锁定
      mockRedisClient.hgetall.mockResolvedValue({
        owner: 'HUMAN',
        epoch: '2',
        staffId: 'staff_007',
        is_handoff_locked: '0',
      });
      // 模拟 returnToBot 成功
      mockRedisClient.eval.mockResolvedValue([1, 3, 'RETURNED']);

      await (timerService as any).handleHumanWaitJob({
        convId: 888,
        senderId: 'wm_cust_001',
        micEpoch: 2,
      });

      // 1. 验证话筒交还 BOT
      expect(mockRedisClient.eval).toHaveBeenCalled();
      // 2. 验证立即触发封组 (HUMAN_TIMEOUT)
      expect(mockSealerService.seal).toHaveBeenCalledWith(888, 'wm_cust_001', 'HUMAN_TIMEOUT');
    });

    it('S9 边缘: 若 AI 主动转人工已锁定 (is_handoff_locked=1)，60s 到期后不应接回', async () => {
      mockRedisClient.hgetall.mockResolvedValue({
        owner: 'HUMAN',
        epoch: '2',
        staffId: 'staff_007',
        is_handoff_locked: '1',
      });

      await (timerService as any).handleHumanWaitJob({
        convId: 888,
        senderId: 'wm_cust_001',
        micEpoch: 2,
      });

      // 话筒被锁定，不交还也不封组
      expect(mockSealerService.seal).not.toHaveBeenCalled();
    });
  });

  describe('5. 抢占范围控制 (S21 验收)', () => {
    it('当 MIC_SEIZE_SCOPE=CS_ONLY 时，普通员工 (STAFF_OTHER) 发言跳过抢话筒', async () => {
      const csOnlyEnv: Env = {
        ...baseEnv,
        MIC_SEIZE_SCOPE: 'CS_ONLY',
      };

      const customInboundService = new InboundPipelineService(
        csOnlyEnv,
        mockMysqlService,
        mockRedisService,
        mockBufferService,
        timerService,
        mockSealerService,
        micService,
        mockStateTransitionService,
      );

      const msg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'group_car_01',
        channelMsgId: 'msg_engineer_01',
        sender: { role: 'STAFF_OTHER', channelUserId: 'eng_001' },
        mentions: [],
        type: 'text',
        text: '系统已部署完毕',
        sentAt: Date.now(),
      };

      const res = await customInboundService.onInbound(msg);

      expect(res.status).toBe('STAFF_HANDLED');
      // 验证未调用 Lua 脚本抢话筒
      expect(mockRedisClient.eval).not.toHaveBeenCalled();
    });

    it('当 MIC_SEIZE_SCOPE=CS_ONLY 时，客服员工 (STAFF_CS) 依然正常抢话筒', async () => {
      const csOnlyEnv: Env = {
        ...baseEnv,
        MIC_SEIZE_SCOPE: 'CS_ONLY',
      };

      mockRedisClient.eval.mockResolvedValue([1, 'BOT', 'HUMAN', 2, 'staff_cs_99', 'STAFF_SEIZED']);

      const customInboundService = new InboundPipelineService(
        csOnlyEnv,
        mockMysqlService,
        mockRedisService,
        mockBufferService,
        timerService,
        mockSealerService,
        micService,
        mockStateTransitionService,
      );

      const msg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'group_car_01',
        channelMsgId: 'msg_cs_01',
        sender: { role: 'STAFF_CS', channelUserId: 'staff_cs_99' },
        mentions: [],
        type: 'text',
        text: '您好，专属客服为您服务',
        sentAt: Date.now(),
      };

      await customInboundService.onInbound(msg);

      expect(mockRedisClient.eval).toHaveBeenCalled();
    });
  });

  describe('6. 客服 @机器人 显式交还话筒', () => {
    it('当客服在群内发言 @机器人 时，话筒显式交还 BOT 并取消 60s 等待', async () => {
      mockRedisClient.eval.mockResolvedValue([1, 4, 'RETURNED']);

      const msg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'group_car_01',
        channelMsgId: 'msg_staff_return',
        sender: { role: 'STAFF_CS', channelUserId: 'staff_007' },
        mentions: ['BOT'],
        type: 'text',
        text: '@机器人 这个问题你来解答一下',
        sentAt: Date.now(),
      };

      const res = await inboundService.onInbound(msg);

      expect(res.status).toBe('STAFF_HANDLED');
      // 验证调用了交还话筒
      expect(mockRedisClient.eval).toHaveBeenCalled();
    });
  });
});
