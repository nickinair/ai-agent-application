/**
 * @file sealer.spec.ts
 * @description 消息封组器单元测试 (SealerService)
 */

import { SealerService, type DbMessageRecord } from '../src/modules/pipeline/sealer.service';
import type { Env } from '../src/config/env';

describe('封组器服务测试 (SealerService)', () => {
  let service: SealerService;
  let mockRedisService: any;
  let mockQueueService: any;
  let mockMysqlService: any;
  let mockBufferService: any;
  let mockTimerService: any;
  let mockCustomerContextService: any;
  let mockTurnQueue: any;
  let mockDbPool: any;

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
    mockTurnQueue = {
      add: jest.fn().mockResolvedValue({ id: 'turn_job_1' }),
    };

    mockQueueService = {
      getQueue: jest.fn().mockReturnValue(mockTurnQueue),
    };

    mockRedisService = {
      acquireLock: jest.fn(),
      getClient: jest.fn().mockReturnValue({
        hset: jest.fn().mockResolvedValue(1),
        del: jest.fn().mockResolvedValue(1),
      }),
    };

    mockBufferService = {
      drain: jest.fn(),
      nonEmptySenders: jest.fn(),
      bumpVersion: jest.fn(),
    };

    mockTimerService = {
      setSealer: jest.fn(),
      scheduleQuiet: jest.fn(),
    };

    mockCustomerContextService = {
      assembleCustomerProfile: jest.fn().mockResolvedValue({
        name: '张三',
        phoneMasked: '138****5678',
        vehicle: '问界M5',
        product: '整车延保',
        bought: false,
      }),
    };

    mockDbPool = {
      query: jest.fn(),
    };

    mockMysqlService = {
      getPool: jest.fn().mockReturnValue(mockDbPool),
    };

    service = new SealerService(
      mockEnv,
      mockRedisService,
      mockQueueService,
      mockMysqlService,
      mockBufferService,
      mockTimerService,
      mockCustomerContextService,
    );
  });

  describe('1. 组内文本按规范拼接 (concatGroupText)', () => {
    it('按 sent_at 升序，文本使用中文逗号连接，图片以 [图片] 占位', () => {
      const messages: DbMessageRecord[] = [
        {
          id: 1,
          tenant_id: 1,
          conversation_id: 101,
          group_id: null,
          channel: 'wecom_group',
          channel_msg_id: 'msg_1',
          sender_role: 'CUSTOMER',
          sender_channel_user_id: 'user_zhang',
          msg_type: 'text',
          content: '在吗',
          sent_at: new Date(1718000000000),
        },
        {
          id: 2,
          tenant_id: 1,
          conversation_id: 101,
          group_id: null,
          channel: 'wecom_group',
          channel_msg_id: 'msg_2',
          sender_role: 'CUSTOMER',
          sender_channel_user_id: 'user_zhang',
          msg_type: 'image',
          media_url: 'https://example.com/pic.jpg',
          sent_at: new Date(1718000001000),
        },
        {
          id: 3,
          tenant_id: 1,
          conversation_id: 101,
          group_id: null,
          channel: 'wecom_group',
          channel_msg_id: 'msg_3',
          sender_role: 'CUSTOMER',
          sender_channel_user_id: 'user_zhang',
          msg_type: 'text',
          content: '保哪些部件，多少钱',
          sent_at: new Date(1718000002000),
        },
      ];

      const { groupText, isOnlyImage } = service.concatGroupText(messages);

      expect(groupText).toBe('在吗，[图片]，保哪些部件，多少钱');
      expect(isOnlyImage).toBe(false);
    });

    it('检测全图片纯媒体组', () => {
      const messages: DbMessageRecord[] = [
        {
          id: 1,
          tenant_id: 1,
          conversation_id: 101,
          group_id: null,
          channel: 'wecom_group',
          channel_msg_id: 'msg_1',
          sender_role: 'CUSTOMER',
          sender_channel_user_id: 'user_zhang',
          msg_type: 'image',
          sent_at: new Date(1718000000000),
        },
      ];

      const { groupText, isOnlyImage } = service.concatGroupText(messages);

      expect(groupText).toBe('[图片]');
      expect(isOnlyImage).toBe(true);
    });
  });

  describe('2. 封组流程排他锁控制 (seal)', () => {
    it('当会话排他锁获取失败时（已有在途组），消息保留在缓冲池直接返回 null', async () => {
      mockRedisService.acquireLock.mockResolvedValue(null);

      const res = await service.seal(101, 'user_zhang', 'QUIET');

      expect(res).toBeNull();
      expect(mockBufferService.drain).not.toHaveBeenCalled();
    });

    it('成功获取锁后，完成消息出池、排序、落库并组装输出标准 TurnContext', async () => {
      const mockLock = {
        release: jest.fn().mockResolvedValue(true),
        renew: jest.fn().mockResolvedValue(true),
      };
      mockRedisService.acquireLock.mockResolvedValue(mockLock);

      // 出池消息 ID
      mockBufferService.drain.mockResolvedValue(['10', '11']);

      // 模拟数据库查询消息
      const dbMessages = [
        {
          id: 10,
          tenant_id: 1,
          conversation_id: 101,
          group_id: null,
          channel: 'wecom_group',
          channel_msg_id: 'msg_10',
          sender_role: 'CUSTOMER',
          sender_channel_user_id: 'user_zhang',
          msg_type: 'text',
          content: '延保多少钱',
          sent_at: new Date(1718000000000),
        },
        {
          id: 11,
          tenant_id: 1,
          conversation_id: 101,
          group_id: null,
          channel: 'wecom_group',
          channel_msg_id: 'msg_11',
          sender_role: 'CUSTOMER',
          sender_channel_user_id: 'user_zhang',
          msg_type: 'text',
          content: '保修范围呢',
          sent_at: new Date(1718000001000),
        },
      ];

      // 模拟会话详情
      const dbConv = {
        id: 101,
        tenant_id: 1,
        channel: 'wecom_group',
        channel_chat_id: 'chat_wework_01',
        chat_name: '张三-13812345678-问界M5-整车延保-未购',
        turn_count: 0,
        rule_pack_version: 'v1.0.0',
      };

      mockDbPool.query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM message')) return [dbMessages];
        if (sql.includes('FROM conversation')) return [[dbConv]];
        if (sql.includes('INSERT INTO msg_group')) return [{ insertId: 201 }];
        if (sql.includes('INSERT INTO turn')) return [{ insertId: 301 }];
        return [[]];
      });

      const context = await service.seal(101, 'user_zhang', 'COUNT');

      expect(context).not.toBeNull();
      expect(context?.groupId).toBe(201);
      expect(context?.turnId).toBe(301);
      expect(context?.isFirstTurn).toBe(true);
      expect(context?.groupText).toBe('延保多少钱，保修范围呢');
      expect(context?.groupMessages.length).toBe(2);
      expect(context?.customer.name).toBe('张三');

      // 验证在途组登记与投递 turn 队列
      expect(mockTurnQueue.add).toHaveBeenCalledWith(
        'run',
        expect.objectContaining({ groupId: 201, turnId: 301 }),
        { jobId: 'turn:201:0' },
      );
    });
  });

  describe('3. 轮次完成善后 (onTurnDone)', () => {
    it('清理在途组、释放会话排他锁，并重新拉起滞留消息计时', async () => {
      mockBufferService.nonEmptySenders.mockResolvedValue(['user_lisi']);
      mockBufferService.bumpVersion.mockResolvedValue({
        version: 5,
        firstAt: Date.now() - 2000,
        count: 1,
      });

      await service.onTurnDone(101);

      const redis = mockRedisService.getClient();
      expect(redis.del).toHaveBeenCalledWith('ag:inflight:101');
      expect(redis.del).toHaveBeenCalledWith('ag:lock:conv:101');
      expect(mockTimerService.scheduleQuiet).toHaveBeenCalledWith(101, 'user_lisi', 5, 3000);
    });
  });
});
