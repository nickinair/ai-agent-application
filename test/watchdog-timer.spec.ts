/**
 * @file watchdog-timer.spec.ts
 * @description 60 秒人工未回复接回看门狗计时器专属单测 (Task 3.5 & 附录 C 用例 S9)
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §3.9.3.2-3、§6.2、附录 C 用例 S9
 */

import { InboundPipelineService } from '../src/modules/pipeline/inbound-pipeline.service';
import { MicrophoneService } from '../src/modules/pipeline/microphone.service';
import { TimerService } from '../src/modules/pipeline/timer.service';
import type { InboundMessage } from '../src/contracts';
import type { Env } from '../src/config/env';

describe('60 秒人工未回复接回看门狗计时器测试 (Task 3.5 & 附录 C 用例 S9)', () => {
  let inboundService: InboundPipelineService;
  let micService: MicrophoneService;
  let timerService: TimerService;

  let mockMysqlService: any;
  let mockRedisService: any;
  let mockBufferService: any;
  let mockSealerService: any;
  let mockQueueService: any;

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
      drain: jest.fn().mockResolvedValue([]),
      getMeta: jest.fn(),
      nonEmptySenders: jest.fn().mockResolvedValue([]),
    };

    mockSealerService = {
      seal: jest.fn().mockResolvedValue({ success: true }),
    };

    const mockJob = {
      remove: jest.fn().mockResolvedValue(true),
    };

    mockTimerQueue = {
      add: jest.fn().mockResolvedValue({ id: 'job_hwait' }),
      getJob: jest.fn().mockResolvedValue(mockJob),
    };

    mockQueueService = {
      getQueue: jest.fn().mockReturnValue(mockTimerQueue),
    };

    micService = new MicrophoneService(baseEnv, mockMysqlService, mockRedisService);
    jest.spyOn(micService, 'getMicStatus').mockResolvedValue({
      owner: 'HUMAN',
      since: Date.now() - 5000,
      staffId: 'staff_007',
      reason: 'STAFF_SEIZED',
      epoch: 2,
      isHandoffLocked: false,
    });
    jest.spyOn(micService, 'seizeByStaff').mockResolvedValue({
      changed: true,
      prevOwner: 'BOT',
      owner: 'HUMAN',
      epoch: 2,
      staffId: 'staff_007',
      reason: 'STAFF_SEIZED',
    });
    jest.spyOn(micService, 'returnToBot').mockResolvedValue({
      success: true,
      epoch: 3,
      reason: 'RETURNED',
    });

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

  describe('1. S9 核心场景 1: 首条客户消息进入，预约 60s 接回任务', () => {
    it('【S9 验收】话筒在 HUMAN 手中，客户发送首条消息，应预约 60s 延时任务且不预约 3s 静默封组', async () => {
      mockBufferService.push.mockResolvedValue({
        count: 1,
        version: 1,
        epoch: 1,
        firstAt: Date.now(),
        isFirst: true,
      });

      const customerMsg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'chat_group_vip',
        channelMsgId: 'msg_cust_wait_01',
        sender: { role: 'CUSTOMER', channelUserId: 'wm_cust_001' },
        mentions: [],
        type: 'text',
        text: '有人在吗？咨询延保价格',
        sentAt: Date.now(),
      };

      const res = await inboundService.onInbound(customerMsg);

      expect(res.status).toBe('PROCESSED');
      expect(res.sealedDirectly).toBe(false);

      // 1. 验证入池
      expect(mockBufferService.push).toHaveBeenCalled();

      // 2. 验证预约了 60s 延迟任务，jobId 为 hwait:888:2
      expect(mockTimerQueue.add).toHaveBeenCalledWith(
        'hwait',
        expect.objectContaining({
          type: 'hwait',
          convId: 888,
          senderId: 'wm_cust_001',
          micEpoch: 2,
        }),
        expect.objectContaining({
          jobId: 'hwait:888:2',
          delay: 60000,
        }),
      );

      // 3. 验证未调度 3s 静默封组任务（话筒在人工手里时机器人静默）
      const quietCall = mockTimerQueue.add.mock.calls.find((c: any[]) => c[0] === 'quiet');
      expect(quietCall).toBeUndefined();
    });
  });

  describe('2. S9 核心场景 2: 客户连发追加消息防重置', () => {
    it('【S9 追问防重置】客户在 60s 等待期间追加发送第 2 条消息，绝对不重复或重置 60s 计时器', async () => {
      const scheduleSpy = jest.spyOn(timerService, 'scheduleHumanWait');

      // 模拟客户发送第 2 条消息 (isFirst: false)
      mockBufferService.push.mockResolvedValue({
        count: 2,
        version: 2,
        epoch: 1,
        firstAt: Date.now() - 10000,
        isFirst: false,
      });

      const customerMsg2: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'chat_group_vip',
        channelMsgId: 'msg_cust_wait_02',
        sender: { role: 'CUSTOMER', channelUserId: 'wm_cust_001' },
        mentions: [],
        type: 'text',
        text: '怎么没人理我？',
        sentAt: Date.now(),
      };

      await inboundService.onInbound(customerMsg2);

      // 验证未调用 scheduleHumanWait，原 60s 计时器继续运行不被重置
      expect(scheduleSpy).not.toHaveBeenCalled();
    });
  });

  describe('3. S9 核心场景 3: 员工发言立即取消 60s 定时任务', () => {
    it('员工在 60s 内发言回复，应立即调用 cancelHumanWait 取消队列任务', async () => {
      const cancelSpy = jest.spyOn(timerService, 'cancelHumanWait');

      const staffMsg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'chat_group_vip',
        channelMsgId: 'msg_staff_intervene',
        sender: { role: 'STAFF_CS', channelUserId: 'staff_007' },
        mentions: [],
        type: 'text',
        text: '来了来了，刚刚在查系统！',
        sentAt: Date.now(),
      };

      await inboundService.onInbound(staffMsg);

      // 验证调用了 cancelHumanWait 取消任务
      expect(cancelSpy).toHaveBeenCalledWith(888, 2);
      expect(mockTimerQueue.getJob).toHaveBeenCalledWith('hwait:888:2');
    });
  });

  describe('4. S9 核心场景 4: 60s 到期自动接回并立即封组 (不发占位应答)', () => {
    it('【S9 到期接回】60s 延时任务到期触发时，话筒原子交还 BOT 并立即封组，绝对不发占位应答', async () => {
      // 模拟 60s 任务到期执行
      await timerService.handleTimerJob({
        data: {
          type: 'hwait',
          convId: 888,
          senderId: 'wm_cust_001',
          micEpoch: 2,
        },
      } as any);

      // 1. 验证话筒自动交还 BOT，原因为 HUMAN_TIMEOUT
      expect(micService.returnToBot).toHaveBeenCalledWith(888, 'HUMAN_TIMEOUT');

      // 2. 验证立即触发封组 (reason=HUMAN_TIMEOUT)
      expect(mockSealerService.seal).toHaveBeenCalledWith(888, 'wm_cust_001', 'HUMAN_TIMEOUT');
    });
  });

  describe('5. S9 场景 5: 主动转人工锁定阻断机制', () => {
    it('当处于主动转人工锁定 (isHandoffLocked=true) 时，客户消息不预约 60s 接回', async () => {
      jest.spyOn(micService, 'getMicStatus').mockResolvedValueOnce({
        owner: 'HUMAN',
        since: Date.now() - 5000,
        staffId: 'staff_007',
        reason: 'STAFF_SEIZED',
        epoch: 2,
        isHandoffLocked: true, // 主动转人工锁定
      });

      mockBufferService.push.mockResolvedValue({
        count: 1,
        version: 1,
        epoch: 1,
        firstAt: Date.now(),
        isFirst: true,
      });

      const customerMsg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'chat_group_vip',
        channelMsgId: 'msg_cust_locked',
        sender: { role: 'CUSTOMER', channelUserId: 'wm_cust_001' },
        mentions: [],
        type: 'text',
        text: '请问人工还在吗？',
        sentAt: Date.now(),
      };

      await inboundService.onInbound(customerMsg);

      // 转人工锁定状态下，不预约 60s 自动接回
      expect(mockTimerQueue.add).not.toHaveBeenCalledWith('hwait', expect.anything(), expect.anything());
    });

    it('若 60s 到期检查时发现话筒已被转人工锁定，安全忽略接回', async () => {
      jest.spyOn(micService, 'getMicStatus').mockResolvedValueOnce({
        owner: 'HUMAN',
        since: Date.now() - 5000,
        staffId: 'staff_007',
        reason: 'STAFF_SEIZED',
        epoch: 2,
        isHandoffLocked: true, // 已被锁定
      });

      await timerService.handleTimerJob({
        data: {
          type: 'hwait',
          convId: 888,
          senderId: 'wm_cust_001',
          micEpoch: 2,
        },
      } as any);

      // 绝不触发接回与封组
      expect(micService.returnToBot).not.toHaveBeenCalled();
      expect(mockSealerService.seal).not.toHaveBeenCalled();
    });
  });
});
