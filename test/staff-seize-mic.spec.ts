import { InboundPipelineService } from '../src/modules/pipeline/inbound-pipeline.service';
import type { InboundMessage } from '../src/contracts';
import type { Env } from '../src/config/env';

describe('员工发言拦截与话筒抢占联动测试 (Task 3.2 & 用例 S21)', () => {
  let service: InboundPipelineService;
  let mockMysqlService: any;
  let mockRedisService: any;
  let mockBufferService: any;
  let mockTimerService: any;
  let mockSealerService: any;
  let mockMicrophoneService: any;
  let mockDbPool: any;
  let mockRedisClient: any;

  function createEnv(micSeizeScope: 'ALL_INTERNAL' | 'CS_ONLY'): Env {
    return {
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
      MIC_SEIZE_SCOPE: micSeizeScope,
      MIC_RETURN_BY_MENTION_ENABLED: false,
      HUMAN_WAIT_TIMEOUT_MS: 60000,
    };
  }

  function setupService(env: Env) {
    mockDbPool = {
      query: jest.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('INSERT INTO message')) return [{ insertId: 1001 }];
        if (sql.includes('SELECT id FROM conversation')) return [[{ id: 701 }]];
        if (sql.includes('UPDATE conversation SET mic_owner')) return [{ affectedRows: 1 }];
        return [[]];
      }),
    };

    mockMysqlService = {
      getPool: jest.fn().mockReturnValue(mockDbPool),
    };

    mockRedisClient = {
      get: jest.fn(),
      set: jest.fn(),
      hset: jest.fn().mockResolvedValue('OK'),
      hgetall: jest.fn().mockResolvedValue({}),
      del: jest.fn().mockResolvedValue(1),
    };

    mockRedisService = {
      getClient: jest.fn().mockReturnValue(mockRedisClient),
    };

    mockBufferService = {
      push: jest.fn().mockResolvedValue({ count: 1, version: 1, epoch: 1 }),
      nonEmptySenders: jest.fn().mockResolvedValue([]),
      drain: jest.fn().mockResolvedValue([]),
    };

    mockTimerService = {
      scheduleQuiet: jest.fn(),
      scheduleHard: jest.fn(),
      scheduleIdle: jest.fn().mockResolvedValue(1),
      scheduleHumanWait: jest.fn().mockResolvedValue(undefined),
      cancelHumanWait: jest.fn().mockResolvedValue(undefined),
    };

    mockSealerService = {
      seal: jest.fn().mockResolvedValue({}),
    };

    mockMicrophoneService = {
      getMicStatus: jest.fn().mockResolvedValue({
        owner: 'BOT',
        epoch: 1,
        isHandoffLocked: false,
        staffId: '',
      }),
      seizeByStaff: jest.fn().mockResolvedValue({
        changed: true,
        owner: 'HUMAN',
        prevOwner: 'BOT',
        epoch: 2,
        staffId: 'staff_001',
        reason: 'STAFF_SEIZED',
      }),
      returnToBot: jest.fn().mockResolvedValue({ success: true, epoch: 3 }),
      returnByMention: jest.fn().mockResolvedValue({ success: true, epoch: 3 }),
    };

    service = new InboundPipelineService(
      env,
      mockMysqlService,
      mockRedisService,
      mockBufferService,
      mockTimerService,
      mockSealerService,
      mockMicrophoneService,
    );
  }

  describe('1. 抢占范围控制 (MIC_SEIZE_SCOPE) 与附录 C 用例 S21 验证', () => {
    it('【S21 场景 A】MIC_SEIZE_SCOPE=ALL_INTERNAL 时：销售顾问 (STAFF_OTHER) 发言成功抢占话筒', async () => {
      setupService(createEnv('ALL_INTERNAL'));

      const msg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'group_s21_chat',
        channelMsgId: 'msg_sales_001',
        sender: { role: 'STAFF_OTHER', channelUserId: 'sales_rep_zhang' },
        mentions: [],
        type: 'text',
        text: '车主您好，我是本店销售顾问，稍后给您发配置表。',
        sentAt: Date.now(),
      };

      const result = await service.onInbound(msg);

      expect(result.status).toBe('STAFF_HANDLED');
      // 验证 seizeByStaff 被调用，成功抢夺话筒
      expect(mockMicrophoneService.seizeByStaff).toHaveBeenCalledWith(
        701,
        'sales_rep_zhang',
        'STAFF_OTHER',
      );
      // 验证取消 60s 接回等待
      expect(mockTimerService.cancelHumanWait).toHaveBeenCalledWith(701, 2);
    });

    it('【S21 场景 B (核心验收门禁)】MIC_SEIZE_SCOPE=CS_ONLY 时：销售顾问 (STAFF_OTHER) 发言跳过抢占，话筒保持不变', async () => {
      setupService(createEnv('CS_ONLY'));

      const msg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'group_s21_chat',
        channelMsgId: 'msg_sales_002',
        sender: { role: 'STAFF_OTHER', channelUserId: 'sales_rep_zhang' },
        mentions: [],
        type: 'text',
        text: '我只是路过插一句，你们继续聊。',
        sentAt: Date.now(),
      };

      const result = await service.onInbound(msg);

      expect(result.status).toBe('STAFF_HANDLED');
      // 核心门禁断言：在 CS_ONLY 下，非客服员工绝对不触发抢话筒
      expect(mockMicrophoneService.seizeByStaff).not.toHaveBeenCalled();
      expect(mockTimerService.cancelHumanWait).not.toHaveBeenCalled();
    });

    it('【S21 场景 C】MIC_SEIZE_SCOPE=CS_ONLY 时：客服人员 (STAFF_CS) 发言依然正常抢占话筒', async () => {
      setupService(createEnv('CS_ONLY'));

      const msg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'group_s21_chat',
        channelMsgId: 'msg_cs_001',
        sender: { role: 'STAFF_CS', channelUserId: 'cs_agent_lisi' },
        mentions: [],
        type: 'text',
        text: '您好，官方售后客服为您解答。',
        sentAt: Date.now(),
      };

      const result = await service.onInbound(msg);

      expect(result.status).toBe('STAFF_HANDLED');
      // 客服人员无视配置限制，强行抢夺话筒
      expect(mockMicrophoneService.seizeByStaff).toHaveBeenCalledWith(
        701,
        'cs_agent_lisi',
        'STAFF_CS',
      );
      expect(mockTimerService.cancelHumanWait).toHaveBeenCalledWith(701, 2);
    });
  });

  describe('2. 话筒状态分流处理', () => {
    it('当话筒已被 HUMAN 持有时：客户消息入缓冲池，但不触发 3s 静默封组回答，并预约 60s 人工超时接回', async () => {
      setupService(createEnv('ALL_INTERNAL'));

      // 模拟话筒在人工手里
      mockMicrophoneService.getMicStatus.mockResolvedValueOnce({
        owner: 'HUMAN',
        epoch: 2,
        isHandoffLocked: false,
        staffId: 'cs_agent_lisi',
      });

      const customerMsg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'group_s21_chat',
        channelMsgId: 'msg_cust_001',
        sender: { role: 'CUSTOMER', channelUserId: 'customer_01' },
        mentions: [],
        type: 'text',
        text: '延保包含哪些核心零部件？',
        sentAt: Date.now(),
      };

      const result = await service.onInbound(customerMsg);

      expect(result.status).toBe('PROCESSED');
      expect(result.sealedDirectly).toBe(false);
      expect(mockBufferService.push).toHaveBeenCalled();

      // 绝不触发静默封组回答机器人
      expect(mockTimerService.scheduleQuiet).not.toHaveBeenCalled();

      // 预约 60s 人工未回复接回检查
      expect(mockTimerService.scheduleHumanWait).toHaveBeenCalledWith(
        701,
        'customer_01',
        2,
      );
    });

    it('当处于主动转人工锁定 (isHandoffLocked=true) 时：客户消息不预约 60s 自动接回', async () => {
      setupService(createEnv('ALL_INTERNAL'));

      // 模拟转人工锁定
      mockMicrophoneService.getMicStatus.mockResolvedValueOnce({
        owner: 'HUMAN',
        epoch: 5,
        isHandoffLocked: true,
        staffId: 'cs_agent_lisi',
      });

      const customerMsg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'group_s21_chat',
        channelMsgId: 'msg_cust_002',
        sender: { role: 'CUSTOMER', channelUserId: 'customer_01' },
        mentions: [],
        type: 'text',
        text: '人工在吗？怎么没人理我？',
        sentAt: Date.now(),
      };

      const result = await service.onInbound(customerMsg);

      expect(result.status).toBe('PROCESSED');
      expect(mockBufferService.push).toHaveBeenCalled();
      // 铁律：转人工锁定后禁止自动接回
      expect(mockTimerService.scheduleHumanWait).not.toHaveBeenCalled();
    });
  });
});
