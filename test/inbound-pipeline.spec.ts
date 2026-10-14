/**
 * @file inbound-pipeline.spec.ts
 * @description 入站消息处理与缓冲流水线单元测试 (InboundPipelineService)
 */

import { InboundPipelineService } from '../src/modules/pipeline/inbound-pipeline.service';
import type { InboundMessage } from '../src/contracts';
import type { Env } from '../src/config/env';

describe('统一入站消息流水线测试 (InboundPipelineService)', () => {
  let service: InboundPipelineService;
  let mockMysqlService: any;
  let mockRedisService: any;
  let mockBufferService: any;
  let mockTimerService: any;
  let mockSealerService: any;
  let mockDbPool: any;
  let mockRedisClient: any;

  const mockEnv: Env = {
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
  };

  beforeEach(() => {
    mockDbPool = {
      query: jest.fn(),
    };

    mockMysqlService = {
      getPool: jest.fn().mockReturnValue(mockDbPool),
    };

    mockRedisClient = {
      get: jest.fn(),
      set: jest.fn(),
      hset: jest.fn(),
    };

    mockRedisService = {
      getClient: jest.fn().mockReturnValue(mockRedisClient),
    };

    mockBufferService = {
      push: jest.fn(),
    };

    mockTimerService = {
      scheduleQuiet: jest.fn(),
      scheduleHard: jest.fn(),
      scheduleIdle: jest.fn().mockResolvedValue(1),
    };

    mockSealerService = {
      seal: jest.fn().mockResolvedValue({}),
    };

    service = new InboundPipelineService(
      mockEnv,
      mockMysqlService,
      mockRedisService,
      mockBufferService,
      mockTimerService,
      mockSealerService,
    );
  });

  describe('1. 数据库幂等拦截', () => {
    it('当发生 MySQL 唯一键冲突 (ER_DUP_ENTRY) 时应直接丢弃并返回 IGNORED_DUPLICATE', async () => {
      const duplicateError: any = new Error('Duplicate entry for key');
      duplicateError.code = 'ER_DUP_ENTRY';
      duplicateError.errno = 1062;

      mockDbPool.query.mockRejectedValue(duplicateError);

      const msg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'chat_01',
        channelMsgId: 'msg_dup_123',
        sender: { role: 'CUSTOMER', channelUserId: 'u_1' },
        mentions: [],
        type: 'text',
        text: '测试重复',
        sentAt: Date.now(),
      };

      const result = await service.onInbound(msg);

      expect(result.status).toBe('IGNORED_DUPLICATE');
      expect(mockBufferService.push).not.toHaveBeenCalled();
    });
  });

  describe('2. 身份识别分流', () => {
    it('当消息来自机器人自身 (BOT) 时只落库并忽略', async () => {
      mockDbPool.query.mockImplementation(async (sql: string) => {
        if (sql.includes('INSERT INTO message')) return [{ insertId: 1001 }];
        if (sql.includes('SELECT id FROM conversation')) return [[{ id: 501 }]];
        return [[]];
      });

      const msg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'chat_01',
        channelMsgId: 'msg_bot_01',
        sender: { role: 'BOT', channelUserId: 'bot_robot_id' },
        mentions: [],
        type: 'text',
        text: '您好，请问有什么可以帮您？',
        sentAt: Date.now(),
      };

      const result = await service.onInbound(msg);

      expect(result.status).toBe('IGNORED_BOT');
      expect(mockBufferService.push).not.toHaveBeenCalled();
    });

    it('当消息来自客服人员 (STAFF_CS) 时触发话筒抢夺', async () => {
      mockDbPool.query.mockImplementation(async (sql: string) => {
        if (sql.includes('INSERT INTO message')) return [{ insertId: 1002 }];
        if (sql.includes('SELECT id FROM conversation')) return [[{ id: 501 }]];
        return [[]];
      });

      const msg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'chat_01',
        channelMsgId: 'msg_staff_01',
        sender: { role: 'STAFF_CS', channelUserId: 'staff_lisi' },
        mentions: [],
        type: 'text',
        text: '收到，我来看一下您的保单',
        sentAt: Date.now(),
      };

      const result = await service.onInbound(msg);

      expect(result.status).toBe('STAFF_HANDLED');
      expect(mockRedisClient.hset).toHaveBeenCalledWith(
        'ag:mic:501',
        expect.objectContaining({ owner: 'HUMAN', staffId: 'staff_lisi' }),
      );
      expect(mockBufferService.push).not.toHaveBeenCalled();
    });
  });

  describe('3. 客户消息入缓冲池与调度', () => {
    it('客户首条消息入池时预约 3s 静默与 15s 熔断计时器', async () => {
      mockDbPool.query.mockImplementation(async (sql: string) => {
        if (sql.includes('INSERT INTO message')) return [{ insertId: 1003 }];
        if (sql.includes('SELECT id FROM conversation')) return [[{ id: 501 }]];
        return [[]];
      });

      // 首条消息 isFirst = true
      mockBufferService.push.mockResolvedValue({
        count: 1,
        version: 1,
        epoch: 1,
        firstAt: 1718000000000,
        isFirst: true,
      });

      const msg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'chat_01',
        channelMsgId: 'msg_customer_01',
        sender: { role: 'CUSTOMER', channelUserId: 'customer_wang' },
        mentions: [],
        type: 'text',
        text: '请问整车延保多少钱？',
        sentAt: 1718000000000,
      };

      const result = await service.onInbound(msg);

      expect(result.status).toBe('PROCESSED');
      expect(result.sealedDirectly).toBe(false);
      expect(mockBufferService.push).toHaveBeenCalled();
      expect(mockTimerService.scheduleQuiet).toHaveBeenCalledWith(501, 'customer_wang', 1, 3000);
      expect(mockTimerService.scheduleHard).toHaveBeenCalledWith(501, 'customer_wang', 1, 15000);
    });

    it('当客户短时间内连发达到 5 条时，直接触发立即封组', async () => {
      mockDbPool.query.mockImplementation(async (sql: string) => {
        if (sql.includes('INSERT INTO message')) return [{ insertId: 1004 }];
        if (sql.includes('SELECT id FROM conversation')) return [[{ id: 501 }]];
        return [[]];
      });

      // 消息数达到上限 5 条
      mockBufferService.push.mockResolvedValue({
        count: 5,
        version: 5,
        epoch: 1,
        firstAt: 1718000000000,
        isFirst: false,
      });

      const msg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'chat_01',
        channelMsgId: 'msg_customer_05',
        sender: { role: 'CUSTOMER', channelUserId: 'customer_wang' },
        mentions: [],
        type: 'text',
        text: '快点回复我',
        sentAt: 1718000004000,
      };

      const result = await service.onInbound(msg);

      expect(result.status).toBe('PROCESSED');
      expect(result.sealedDirectly).toBe(true);
      expect(mockSealerService.seal).toHaveBeenCalledWith(501, 'customer_wang', 'COUNT');
    });
  });
});
