/**
 * @file watchdog.spec.ts
 * @description 智能体全能平台崩溃与在途组扫描看门狗服务单元测试 (WatchdogService / S18 用例)
 */

import { WatchdogService } from '../src/modules/pipeline/watchdog.service';
import type { MysqlService } from '../src/database/mysql.service';
import type { RedisService } from '../src/infra/redis/redis.service';
import type { StateTransitionService } from '../src/modules/pipeline/state-transition.service';
import type { SealerService } from '../src/modules/pipeline/sealer.service';

describe('崩溃与在途组扫描看门狗服务测试 (WatchdogService)', () => {
  let service: WatchdogService;
  let mockEnv: any;
  let mockDbPool: any;
  let mockMysqlService: any;
  let mockRedisClient: any;
  let mockRedisService: any;
  let mockStateTransitionService: any;
  let mockSealerService: any;

  beforeEach(() => {
    mockEnv = {
      NODE_ENV: 'test',
    };

    mockDbPool = {
      query: jest.fn(),
    };

    mockMysqlService = {
      getPool: jest.fn().mockReturnValue(mockDbPool),
    } as unknown as MysqlService;

    mockRedisClient = {
      keys: jest.fn(),
      hgetall: jest.fn(),
      del: jest.fn().mockResolvedValue(1),
    };

    mockRedisService = {
      getClient: jest.fn().mockReturnValue(mockRedisClient),
    } as unknown as RedisService;

    mockStateTransitionService = {
      transition: jest.fn().mockResolvedValue(undefined),
    } as unknown as StateTransitionService;

    mockSealerService = {
      onTurnDone: jest.fn().mockResolvedValue(undefined),
    } as unknown as SealerService;

    service = new WatchdogService(
      mockEnv,
      mockMysqlService,
      mockRedisService,
      mockStateTransitionService,
      mockSealerService,
    );
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  describe('1. 在途超时检测与正常流转放行', () => {
    it('正常在途任务 (耗时 3s < 8s): 不触发降级，维持原状', async () => {
      const now = 1700000010000;
      mockRedisClient.keys.mockResolvedValue(['ag:inflight:1001']);
      mockRedisClient.hgetall.mockResolvedValue({
        groupId: '501',
        sealedAt: String(now - 3000), // 3 秒前
        turnId: '21',
      });

      const report = await service.scanAndRecover(now);

      expect(report.scanned).toBe(1);
      expect(report.skipped).toBe(1);
      expect(report.recovered).toBe(0);
      expect(report.clearedStale).toBe(0);

      // 不调用状态流转
      expect(mockStateTransitionService.transition).not.toHaveBeenCalled();
      // 不写入降级话术
      expect(mockDbPool.query).not.toHaveBeenCalled();
      // 不清理键
      expect(mockRedisClient.del).not.toHaveBeenCalled();
      // 不调用 onTurnDone
      expect(mockSealerService.onTurnDone).not.toHaveBeenCalled();
    });
  });

  describe('2. S18 核心用例: UNDERSTANDING / FINAL_CHECKING 阶段超 8s 降级自愈闭环', () => {
    it('S18: Worker 在组 UNDERSTANDING 时崩溃，超 8s 触发降级流转、发降级话术、解会话锁并唤醒滞留消息', async () => {
      const now = 1700000020000;
      const convId = '1002';
      const groupId = '502';

      mockRedisClient.keys.mockResolvedValue([`ag:inflight:${convId}`]);
      mockRedisClient.hgetall.mockResolvedValue({
        groupId,
        sealedAt: String(now - 9000), // 9 秒前，超 8s
        turnId: '22',
      });

      // 模拟查询 msg_group 表返回处于 UNDERSTANDING 状态
      mockDbPool.query.mockImplementation((sql: string) => {
        if (sql.includes('FROM msg_group')) {
          return [
            [
              {
                id: 502,
                tenant_id: 1,
                conversation_id: 1002,
                status: 'UNDERSTANDING',
              },
            ],
          ];
        }
        if (sql.includes('FROM conversation')) {
          return [[{ id: 1002, channel: 'wecom', channel_chat_id: 'chat_corp_001' }]];
        }
        if (sql.includes('INSERT INTO message')) {
          return [{ insertId: 888 }];
        }
        return [[]];
      });

      const report = await service.scanAndRecover(now);

      expect(report.scanned).toBe(1);
      expect(report.recovered).toBe(1);

      // ① 必须调用 StateTransitionService 将状态机流转为 SENT
      expect(mockStateTransitionService.transition).toHaveBeenCalledWith(
        'GROUP',
        groupId,
        'UNDERSTANDING',
        'SENT',
        expect.objectContaining({
          tenantId: 1,
          operatorType: 'TIMEOUT',
          reason: 'WATCHDOG_TIMEOUT_FALLBACK',
          metadata: expect.objectContaining({
            convId,
            elapsedMs: 9000,
            originalStatus: 'UNDERSTANDING',
          }),
        }),
      );

      // ② 必须向 message 表写入降级友好话术
      expect(mockDbPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO message'),
        expect.arrayContaining([
          1, // tenant_id
          1002, // conversation_id
          502, // group_id
          'wecom', // channel
          expect.stringContaining('fallback_'), // channel_msg_id
          '网络繁忙，稍后为您服务', // content
        ]),
      );

      // ③ 必须清除 Redis 在途键与会话排他锁
      expect(mockRedisClient.del).toHaveBeenCalledWith(`ag:inflight:${convId}`);
      expect(mockRedisClient.del).toHaveBeenCalledWith(`ag:lock:conv:${convId}`);

      // ④ 必须调用 sealerService.onTurnDone 唤醒滞留消息（满足 S18 "消息不丢"）
      expect(mockSealerService.onTurnDone).toHaveBeenCalledWith(convId);
    });

    it('FINAL_CHECKING 阶段超时挂死：同样顺利触发自愈闭环', async () => {
      const now = 1700000030000;
      const convId = '1003';
      const groupId = '503';

      mockRedisClient.keys.mockResolvedValue([`ag:inflight:${convId}`]);
      mockRedisClient.hgetall.mockResolvedValue({
        groupId,
        sealedAt: String(now - 12000), // 12 秒前
        turnId: '23',
      });

      mockDbPool.query.mockImplementation((sql: string) => {
        if (sql.includes('FROM msg_group')) {
          return [
            [
              {
                id: 503,
                tenant_id: 1,
                conversation_id: 1003,
                status: 'FINAL_CHECKING',
              },
            ],
          ];
        }
        if (sql.includes('FROM conversation')) {
          return [[{ id: 1003, channel: 'wecom', channel_chat_id: 'chat_corp_002' }]];
        }
        return [{ insertId: 889 }];
      });

      const report = await service.scanAndRecover(now);

      expect(report.recovered).toBe(1);
      expect(mockStateTransitionService.transition).toHaveBeenCalledWith(
        'GROUP',
        groupId,
        'FINAL_CHECKING',
        'SENT',
        expect.anything(),
      );
    });
  });

  describe('3. 残留与异常键清理', () => {
    it('DB 中组已处于终态 (SENT): 判定为 Redis 键残留，仅清理键不重复发消息', async () => {
      const now = 1700000040000;
      const convId = '1004';
      const groupId = '504';

      mockRedisClient.keys.mockResolvedValue([`ag:inflight:${convId}`]);
      mockRedisClient.hgetall.mockResolvedValue({
        groupId,
        sealedAt: String(now - 15000),
        turnId: '24',
      });

      mockDbPool.query.mockImplementation((sql: string) => {
        if (sql.includes('FROM msg_group')) {
          return [
            [
              {
                id: 504,
                tenant_id: 1,
                conversation_id: 1004,
                status: 'SENT', // 已是终态
              },
            ],
          ];
        }
        return [[]];
      });

      const report = await service.scanAndRecover(now);

      expect(report.scanned).toBe(1);
      expect(report.recovered).toBe(0);
      expect(report.clearedStale).toBe(1);

      // 不应再流转状态机或插入消息
      expect(mockStateTransitionService.transition).not.toHaveBeenCalled();
      expect(mockDbPool.query).not.toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO message'),
        expect.anything(),
      );

      // 必须清理残留键
      expect(mockRedisClient.del).toHaveBeenCalledWith(`ag:inflight:${convId}`);
      expect(mockRedisClient.del).toHaveBeenCalledWith(`ag:lock:conv:${convId}`);
    });

    it('孤儿在途键 (DB 中查无对应 msg_group): 清理无效 Redis 键', async () => {
      const now = 1700000050000;
      const convId = '1005';

      mockRedisClient.keys.mockResolvedValue([`ag:inflight:${convId}`]);
      mockRedisClient.hgetall.mockResolvedValue({
        groupId: '999999',
        sealedAt: String(now - 20000),
      });

      mockDbPool.query.mockResolvedValue([[]]); // 无记录

      const report = await service.scanAndRecover(now);

      expect(report.clearedStale).toBe(1);
      expect(mockRedisClient.del).toHaveBeenCalledWith(`ag:inflight:${convId}`);
    });

    it('破损 Hash 数据 (缺少 groupId 或 sealedAt): 直接清理', async () => {
      const now = 1700000060000;
      const convId = '1006';

      mockRedisClient.keys.mockResolvedValue([`ag:inflight:${convId}`]);
      mockRedisClient.hgetall.mockResolvedValue({}); // 空 Hash

      const report = await service.scanAndRecover(now);

      expect(report.clearedStale).toBe(1);
      expect(mockRedisClient.del).toHaveBeenCalledWith(`ag:inflight:${convId}`);
    });
  });

  describe('4. 生命周期与配置管理', () => {
    it('onApplicationBootstrap 触发首次扫描并注册定时器，onModuleDestroy 释放定时器', async () => {
      mockRedisClient.keys.mockResolvedValue([]);
      const scanSpy = jest.spyOn(service, 'scanAndRecover');

      await service.onApplicationBootstrap();

      expect(scanSpy).toHaveBeenCalled();

      // 再次销毁，不抛异常
      service.onModuleDestroy();
    });

    it('支持动态调整超时阈值与兜底话术', async () => {
      service.setTimeoutMs(3000);
      service.setFallbackText('测试自定义兜底回复');

      const now = 1700000070000;
      const convId = '1007';
      const groupId = '507';

      mockRedisClient.keys.mockResolvedValue([`ag:inflight:${convId}`]);
      mockRedisClient.hgetall.mockResolvedValue({
        groupId,
        sealedAt: String(now - 4000), // 4 秒前，超过定制的 3s
        turnId: '27',
      });

      mockDbPool.query.mockImplementation((sql: string) => {
        if (sql.includes('FROM msg_group')) {
          return [
            [
              {
                id: 507,
                tenant_id: 1,
                conversation_id: 1007,
                status: 'UNDERSTANDING',
              },
            ],
          ];
        }
        if (sql.includes('FROM conversation')) {
          return [[{ id: 1007, channel: 'wecom', channel_chat_id: 'chat_corp_007' }]];
        }
        return [{ insertId: 890 }];
      });

      const report = await service.scanAndRecover(now);
      expect(report.recovered).toBe(1);

      expect(mockDbPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO message'),
        expect.arrayContaining(['测试自定义兜底回复']),
      );
    });
  });
});
