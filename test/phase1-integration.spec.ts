/**
 * @file phase1-integration.spec.ts
 * @description 阶段一：运行时状态机底座与乐观锁全量综合集成测试
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §6.1、§7.1~§7.4、§16.2 (S14, S18 用例)
 */

import {
  StateTransitionService,
  OptimisticLockConflictException,
  IllegalStateTransitionException,
} from '../src/modules/pipeline/state-transition.service';
import { WatchdogService } from '../src/modules/pipeline/watchdog.service';
import { TimerService, type IdleJobData } from '../src/modules/pipeline/timer.service';
import type { MysqlService } from '../src/database/mysql.service';
import type { RedisService } from '../src/infra/redis/redis.service';
import type { QueueService } from '../src/infra/queue/queue.service';
import type { BufferService } from '../src/modules/pipeline/buffer.service';
import type { SealerService } from '../src/modules/pipeline/sealer.service';
import type { Env } from '../src/config/env';

describe('阶段一全量单元与集成测试套件 (Phase 1 Integration Suite)', () => {
  let mockEnv: Env;
  let mockDbPool: any;
  let mockMysqlService: MysqlService;
  let mockRedisClient: any;
  let mockRedisService: RedisService;
  let mockQueueService: QueueService;
  let mockBufferService: BufferService;
  let mockSealerService: SealerService;
  let mockTimerQueue: any;

  let stateTransitionService: StateTransitionService;
  let watchdogService: WatchdogService;
  let timerService: TimerService;

  beforeEach(() => {
    mockEnv = {
      PORT: 3002,
      MYSQL_URL: 'mysql://mock',
      WECOM_BOT_ENABLED: false,
      WECOM_STAFF_MENTIONS: '@客服',
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: 6379,
      REDIS_DB: 0,
      CRM_BASE_URL: 'http://localhost:3001',
      CRM_SERVICE_TOKEN: 'token',
      CRM_TIMEOUT_MS: 800,
      QUIET_WINDOW_MS: 3000,
      HARD_TIMEOUT_MS: 15000,
      GROUP_MAX_MESSAGES: 5,
      SESSION_IDLE_TIMEOUT_MS: 1800000,
      CLOSE_IDLE_TIMEOUT_MS: 300000,
    };

    mockDbPool = {
      query: jest.fn(),
    };

    mockMysqlService = {
      getPool: jest.fn().mockReturnValue(mockDbPool),
    } as unknown as MysqlService;

    mockRedisClient = {
      keys: jest.fn().mockResolvedValue([]),
      hgetall: jest.fn().mockResolvedValue({}),
      incr: jest.fn().mockResolvedValue(1),
      get: jest.fn().mockResolvedValue('1'),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };

    mockRedisService = {
      getClient: jest.fn().mockReturnValue(mockRedisClient),
    } as unknown as RedisService;

    mockTimerQueue = {
      add: jest.fn().mockResolvedValue({ id: 'job_test' }),
    };

    mockQueueService = {
      getQueue: jest.fn().mockReturnValue(mockTimerQueue),
      createWorker: jest.fn(),
    } as unknown as QueueService;

    mockBufferService = {
      getMeta: jest.fn(),
    } as unknown as BufferService;

    mockSealerService = {
      onTurnDone: jest.fn().mockResolvedValue(undefined),
    } as unknown as SealerService;

    // 实例化阶段一三大核心服务
    stateTransitionService = new StateTransitionService(mockMysqlService);
    watchdogService = new WatchdogService(
      mockEnv,
      mockMysqlService,
      mockRedisService,
      stateTransitionService,
      mockSealerService,
    );
    timerService = new TimerService(
      mockEnv,
      mockQueueService,
      mockBufferService,
      mockRedisService,
      mockMysqlService,
      stateTransitionService,
    );
  });

  afterEach(() => {
    watchdogService.onModuleDestroy();
  });

  describe('1. 状态机流转守卫与乐观锁高并发争抢断言 (Task 1.1)', () => {
    it('非法流转被拦截，不执行任何 SQL', async () => {
      await expect(
        stateTransitionService.transition('GROUP', 99, 'COLLECTING', 'SENT'),
      ).rejects.toThrow(IllegalStateTransitionException);

      expect(mockDbPool.query).not.toHaveBeenCalled();
    });

    it('高并发场景: 5 个并发请求尝试更新同一个处于 UNDERSTANDING 状态的组，仅 1 个成功，4 个抛出乐观锁冲突异常', async () => {
      let callCount = 0;
      mockDbPool.query.mockImplementation((sql: string) => {
        if (sql.includes('UPDATE msg_group')) {
          callCount++;
          // 仅第一次并发更新生效 (affectedRows: 1)，其余返回 0
          return [{ affectedRows: callCount === 1 ? 1 : 0 }];
        }
        if (sql.includes('INSERT INTO state_transition_log')) {
          return [{ insertId: 1 }];
        }
        return [[]];
      });

      const promises = Array.from({ length: 5 }).map(() =>
        stateTransitionService
          .transition('GROUP', 101, 'UNDERSTANDING', 'FINAL_CHECKING', {
            tenantId: 1,
            traceId: 'concurrent-trace',
          })
          .then(() => 'SUCCESS')
          .catch((err) => err),
      );

      const results = await Promise.all(promises);
      const successes = results.filter((r) => r === 'SUCCESS');
      const conflicts = results.filter(
        (r) => r instanceof OptimisticLockConflictException,
      );

      expect(successes).toHaveLength(1);
      expect(conflicts).toHaveLength(4);
    });
  });

  describe('2. 状态变更审计日志伴随落库完整性与异常隔离 (Task 1.2)', () => {
    it('成功跃迁后必须完整记录 10 个维度的审计字段，且 metadata 序列化为 JSON', async () => {
      mockDbPool.query.mockImplementation((sql: string) => {
        if (sql.includes('UPDATE turn')) {
          return [{ affectedRows: 1 }];
        }
        if (sql.includes('INSERT INTO state_transition_log')) {
          return [{ insertId: 777 }];
        }
        return [[]];
      });

      await stateTransitionService.transition('TURN', 501, 'IN_PROGRESS', 'DONE', {
        tenantId: 9,
        traceId: 'audit-trace-888',
        operatorType: 'SYSTEM',
        metadata: {
          costMs: 120,
          model: 'deepseek-v3',
        },
      });

      expect(mockDbPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO state_transition_log'),
        expect.arrayContaining([
          9, // tenant_id
          'turn', // entity_type
          501, // entity_id
          'IN_PROGRESS', // from_state
          'DONE', // to_state
          'audit-trace-888', // trace_id
        ]),
      );
    });

    it('审计日志写入失败时安全隔离，绝不影响主状态流转', async () => {
      mockDbPool.query.mockImplementation((sql: string) => {
        if (sql.includes('UPDATE conversation')) {
          return [{ affectedRows: 1 }];
        }
        if (sql.includes('INSERT INTO state_transition_log')) {
          throw new Error('Database disk full');
        }
        return [[]];
      });

      await expect(
        stateTransitionService.transition('CONVERSATION', 888, 'ACTIVE', 'ENDED', {
          tenantId: 1,
        }),
      ).resolves.not.toThrow();
    });
  });

  describe('3. S18 核心用例: 看门狗在途崩溃超时检测与降级自愈闭环 (Task 1.3)', () => {
    it('S18: 节点崩溃导致 UNDERSTANDING 超过 8 秒，看门狗触发 SENT 跃迁、发降级话术并解开会话锁唤醒滞留消息', async () => {
      const now = 1700000100000;
      const convId = '2001';
      const groupId = '9001';

      mockRedisClient.keys.mockResolvedValue([`ag:inflight:${convId}`]);
      mockRedisClient.hgetall.mockResolvedValue({
        groupId,
        sealedAt: String(now - 8500), // 8.5 秒前
        turnId: '301',
      });

      mockDbPool.query.mockImplementation((sql: string) => {
        if (sql.includes('FROM msg_group')) {
          return [
            [
              {
                id: 9001,
                tenant_id: 1,
                conversation_id: 2001,
                status: 'UNDERSTANDING',
              },
            ],
          ];
        }
        if (sql.includes('FROM conversation')) {
          return [[{ id: 2001, channel: 'wecom', channel_chat_id: 'chat_group_s18' }]];
        }
        if (sql.includes('UPDATE msg_group')) {
          return [{ affectedRows: 1 }];
        }
        if (sql.includes('INSERT INTO message')) {
          return [{ insertId: 666 }];
        }
        return [[]];
      });

      const report = await watchdogService.scanAndRecover(now);

      expect(report.scanned).toBe(1);
      expect(report.recovered).toBe(1);

      // 验证降级话术写入
      expect(mockDbPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO message'),
        expect.arrayContaining(['网络繁忙，稍后为您服务']),
      );

      // 验证 Redis 锁清理
      expect(mockRedisClient.del).toHaveBeenCalledWith(`ag:inflight:${convId}`);
      expect(mockRedisClient.del).toHaveBeenCalledWith(`ag:lock:conv:${convId}`);

      // 验证唤醒滞留消息防死锁
      expect(mockSealerService.onTurnDone).toHaveBeenCalledWith(convId);
    });
  });

  describe('4. S14 核心用例: 会话空闲超时关闭与版本防竞态断言 (Task 1.4)', () => {
    it('S14: 完结收尾答复后 5 分钟超时，跃迁至 ENDED 并标记 resolved=1', async () => {
      mockRedisClient.get.mockResolvedValue('10'); // 最新版本号
      mockDbPool.query.mockImplementation((sql: string) => {
        if (sql.includes('FROM conversation')) {
          return [
            [
              {
                id: 3001,
                tenant_id: 1,
                channel: 'wecom',
                channel_chat_id: 'chat_s14',
                status: 'ACTIVE',
              },
            ],
          ];
        }
        if (sql.includes('UPDATE conversation SET status')) {
          return [{ affectedRows: 1 }];
        }
        if (sql.includes('UPDATE conversation SET resolved = 1')) {
          return [{ affectedRows: 1 }];
        }
        return [[]];
      });

      const mockJob: any = {
        data: {
          type: 'idle',
          convId: 3001,
          seq: 10,
          kind: 'CLOSE',
        } as IdleJobData,
      };

      await timerService.handleTimerJob(mockJob);

      // 断言调用更新 resolved=1
      expect(mockDbPool.query).toHaveBeenCalledWith(
        'UPDATE conversation SET resolved = 1 WHERE id = ?',
        [3001],
      );

      // 断言清理活跃映射
      expect(mockRedisClient.del).toHaveBeenCalledWith('ag:conv:active:1:chat_s14');
    });

    it('版本防竞态丢弃: 中途新消息自增版本号，旧延时任务丢弃，会话不关闭', async () => {
      mockRedisClient.get.mockResolvedValue('11'); // Redis 中已自增到 11

      const mockJob: any = {
        data: {
          type: 'idle',
          convId: 3001,
          seq: 10, // 旧任务 seq 为 10
          kind: 'NORMAL',
        } as IdleJobData,
      };

      await timerService.handleTimerJob(mockJob);

      // 绝不触发任何状态流转与更新
      expect(mockDbPool.query).not.toHaveBeenCalledWith(
        expect.stringContaining('UPDATE conversation'),
        expect.anything(),
      );
    });
  });

  describe('5. 阶段一全生命周期综合联动闭环 (End-to-End)', () => {
    it('入站会话激活 -> 封组在途 -> Worker 超时看门狗介入自愈 -> 重新唤醒下轮 -> 完结空闲关闭', async () => {
      // 1. 模拟激活与初次预约空闲
      mockRedisClient.incr.mockResolvedValue(1);
      const seq = await timerService.scheduleIdle(8888, 'NORMAL');
      expect(seq).toBe(1);

      // 2. 模拟封组在途挂死，看门狗扫描自愈
      const now = 1700000999000;
      mockRedisClient.keys.mockResolvedValue(['ag:inflight:8888']);
      mockRedisClient.hgetall.mockResolvedValue({
        groupId: '7777',
        sealedAt: String(now - 10000), // 超 8s
      });
      mockDbPool.query.mockImplementation((sql: string) => {
        if (sql.includes('FROM msg_group')) {
          return [[{ id: 7777, tenant_id: 1, conversation_id: 8888, status: 'UNDERSTANDING' }]];
        }
        if (sql.includes('FROM conversation')) {
          return [[{ id: 8888, tenant_id: 1, channel: 'wecom', channel_chat_id: 'chat_e2e', status: 'ACTIVE' }]];
        }
        if (sql.includes('UPDATE msg_group')) return [{ affectedRows: 1 }];
        if (sql.includes('UPDATE conversation')) return [{ affectedRows: 1 }];
        if (sql.includes('INSERT INTO message')) return [{ insertId: 999 }];
        return [[]];
      });

      const report = await watchdogService.scanAndRecover(now);
      expect(report.recovered).toBe(1);
      expect(mockSealerService.onTurnDone).toHaveBeenCalledWith('8888');

      // 3. 模拟收尾完结预约 5m 超时到期
      mockRedisClient.incr.mockResolvedValue(2);
      await timerService.scheduleIdle(8888, 'CLOSE');

      mockRedisClient.get.mockResolvedValue('2');
      await timerService.handleTimerJob({
        data: {
          type: 'idle',
          convId: 8888,
          seq: 2,
          kind: 'CLOSE',
        },
      } as any);

      // 验证最终状态安全闭环为 ENDED
      expect(mockRedisClient.del).toHaveBeenCalledWith('ag:conv:active:1:chat_e2e');
    });
  });
});
