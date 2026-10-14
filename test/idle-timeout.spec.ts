/**
 * @file idle-timeout.spec.ts
 * @description 智能体全能平台会话空闲超时关闭机制单元测试 (Task 1.4 / S14 用例延展)
 */

import { TimerService, type IdleJobData } from '../src/modules/pipeline/timer.service';
import type { Env } from '../src/config/env';
import type { QueueService } from '../src/infra/queue/queue.service';
import type { BufferService } from '../src/modules/pipeline/buffer.service';
import type { RedisService } from '../src/infra/redis/redis.service';
import type { MysqlService } from '../src/database/mysql.service';
import type { StateTransitionService } from '../src/modules/pipeline/state-transition.service';

describe('会话空闲超时关闭机制测试 (TimerService Idle Timeout)', () => {
  let service: TimerService;
  let mockEnv: Env;
  let mockQueueService: any;
  let mockBufferService: any;
  let mockRedisClient: any;
  let mockRedisService: any;
  let mockDbPool: any;
  let mockMysqlService: any;
  let mockStateTransitionService: any;
  let mockTimerQueue: any;

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
      SESSION_IDLE_TIMEOUT_MS: 1800000, // 30 分钟
      CLOSE_IDLE_TIMEOUT_MS: 300000, // 5 分钟
    };

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

    mockRedisClient = {
      incr: jest.fn().mockResolvedValue(1),
      get: jest.fn().mockResolvedValue('1'),
      del: jest.fn().mockResolvedValue(1),
    };

    mockRedisService = {
      getClient: jest.fn().mockReturnValue(mockRedisClient),
    } as unknown as RedisService;

    mockDbPool = {
      query: jest.fn(),
    };

    mockMysqlService = {
      getPool: jest.fn().mockReturnValue(mockDbPool),
    } as unknown as MysqlService;

    mockStateTransitionService = {
      transition: jest.fn().mockResolvedValue(undefined),
    } as unknown as StateTransitionService;

    service = new TimerService(
      mockEnv,
      mockQueueService,
      mockBufferService,
      mockRedisService,
      mockMysqlService,
      mockStateTransitionService,
    );
  });

  describe('1. 任务调度预约 (scheduleIdle)', () => {
    it('普通会话空闲调度 (NORMAL): 默认延时 30 分钟 (1800000ms)，版本号自增并构造 jobId', async () => {
      mockRedisClient.incr.mockResolvedValue(42);

      const seq = await service.scheduleIdle(101, 'NORMAL');

      expect(seq).toBe(42);
      expect(mockRedisClient.incr).toHaveBeenCalledWith('ag:idle:seq:101');
      expect(mockQueueService.getQueue).toHaveBeenCalledWith('agent.queue.timer');
      expect(mockTimerQueue.add).toHaveBeenCalledWith(
        'idle',
        {
          type: 'idle',
          convId: 101,
          seq: 42,
          kind: 'NORMAL',
        },
        expect.objectContaining({
          jobId: 'idle:101:42',
          delay: 1800000,
        }),
      );
    });

    it('完结收尾空闲调度 (CLOSE / S14): 默认延时 5 分钟 (300000ms)', async () => {
      mockRedisClient.incr.mockResolvedValue(9);

      const seq = await service.scheduleIdle(202, 'CLOSE');

      expect(seq).toBe(9);
      expect(mockRedisClient.incr).toHaveBeenCalledWith('ag:idle:seq:202');
      expect(mockTimerQueue.add).toHaveBeenCalledWith(
        'idle',
        {
          type: 'idle',
          convId: 202,
          seq: 9,
          kind: 'CLOSE',
        },
        expect.objectContaining({
          jobId: 'idle:202:9',
          delay: 300000,
        }),
      );
    });

    it('支持显式传入自定义 delayMs', async () => {
      await service.scheduleIdle(303, 'NORMAL', 10000);

      expect(mockTimerQueue.add).toHaveBeenCalledWith(
        'idle',
        expect.anything(),
        expect.objectContaining({
          delay: 10000,
        }),
      );
    });
  });

  describe('2. 到期处理与状态机流转 (handleTimerJob)', () => {
    it('普通 30m 超时到期: 版本匹配，跃迁会话至 ENDED，记录 reason=IDLE，清理 Redis 活跃缓存', async () => {
      mockRedisClient.get.mockResolvedValue('5'); // 当前 Redis 版本号为 5
      mockDbPool.query.mockImplementation((sql: string) => {
        if (sql.includes('FROM conversation')) {
          return [
            [
              {
                id: 101,
                tenant_id: 1,
                channel: 'wecom',
                channel_chat_id: 'chat_group_101',
                status: 'ACTIVE',
              },
            ],
          ];
        }
        return [[]];
      });

      const mockJob: any = {
        data: {
          type: 'idle',
          convId: 101,
          seq: 5,
          kind: 'NORMAL',
        } as IdleJobData,
      };

      await service.handleTimerJob(mockJob);

      // ① 调用状态流转服务
      expect(mockStateTransitionService.transition).toHaveBeenCalledWith(
        'CONVERSATION',
        101,
        'ACTIVE',
        'ENDED',
        expect.objectContaining({
          tenantId: 1,
          operatorType: 'TIMEOUT',
          reason: 'IDLE',
          metadata: expect.objectContaining({
            kind: 'NORMAL',
            seq: 5,
          }),
        }),
      );

      // ② 清理活跃会话 Key 与序列号
      expect(mockRedisClient.del).toHaveBeenCalledWith('ag:conv:active:1:chat_group_101');
      expect(mockRedisClient.del).toHaveBeenCalledWith('ag:idle:seq:101');
      expect(mockRedisClient.del).toHaveBeenCalledWith('ag:mic:101');
    });

    it('完结收尾 5m 超时到期 (S14 用例): 跃迁至 ENDED，reason=CLOSE_IDLE，更新 resolved=1', async () => {
      mockRedisClient.get.mockResolvedValue('3');
      mockDbPool.query.mockImplementation((sql: string) => {
        if (sql.includes('FROM conversation')) {
          return [
            [
              {
                id: 202,
                tenant_id: 2,
                channel: 'wecom',
                channel_chat_id: 'chat_group_202',
                status: 'ACTIVE',
              },
            ],
          ];
        }
        if (sql.includes('UPDATE conversation SET resolved = 1')) {
          return [{ affectedRows: 1 }];
        }
        return [[]];
      });

      const mockJob: any = {
        data: {
          type: 'idle',
          convId: 202,
          seq: 3,
          kind: 'CLOSE',
        } as IdleJobData,
      };

      await service.handleTimerJob(mockJob);

      // ① 状态跃迁至 ENDED
      expect(mockStateTransitionService.transition).toHaveBeenCalledWith(
        'CONVERSATION',
        202,
        'ACTIVE',
        'ENDED',
        expect.objectContaining({
          reason: 'CLOSE_IDLE',
        }),
      );

      // ② 必须更新 resolved = 1
      expect(mockDbPool.query).toHaveBeenCalledWith(
        'UPDATE conversation SET resolved = 1 WHERE id = ?',
        [202],
      );

      // ③ 清理 Redis 活跃缓存
      expect(mockRedisClient.del).toHaveBeenCalledWith('ag:conv:active:2:chat_group_202');
    });
  });

  describe('3. 防竞态版本号机制与防御性判断', () => {
    it('版本号不匹配 (中途有新消息触发版本自增): 安全丢弃旧任务，会话保持活跃', async () => {
      // 任务中的 seq 是 3，但 Redis 中已自增到 4（说明期间收到了新消息续期）
      mockRedisClient.get.mockResolvedValue('4');

      const mockJob: any = {
        data: {
          type: 'idle',
          convId: 101,
          seq: 3,
          kind: 'NORMAL',
        } as IdleJobData,
      };

      await service.handleTimerJob(mockJob);

      // 绝不触发状态机跃迁
      expect(mockStateTransitionService.transition).not.toHaveBeenCalled();
      // 绝不执行 DB 查询或更新
      expect(mockDbPool.query).not.toHaveBeenCalled();
      // 绝不删除活跃会话 Key
      expect(mockRedisClient.del).not.toHaveBeenCalled();
    });

    it('会话在 DB 中已不是 ACTIVE 状态: 安全忽略，不重复触发流转', async () => {
      mockRedisClient.get.mockResolvedValue('7');
      mockDbPool.query.mockResolvedValue([
        [
          {
            id: 101,
            tenant_id: 1,
            channel_chat_id: 'chat_101',
            status: 'ENDED', // 已由人工或之前流程结束
          },
        ],
      ]);

      const mockJob: any = {
        data: {
          type: 'idle',
          convId: 101,
          seq: 7,
          kind: 'NORMAL',
        } as IdleJobData,
      };

      await service.handleTimerJob(mockJob);

      expect(mockStateTransitionService.transition).not.toHaveBeenCalled();
      expect(mockRedisClient.del).toHaveBeenCalledWith('ag:idle:seq:101');
    });

    it('会话在 DB 中查无记录: 清理残留序列号', async () => {
      mockRedisClient.get.mockResolvedValue('1');
      mockDbPool.query.mockResolvedValue([[]]); // 无记录

      const mockJob: any = {
        data: {
          type: 'idle',
          convId: 9999,
          seq: 1,
          kind: 'NORMAL',
        } as IdleJobData,
      };

      await service.handleTimerJob(mockJob);

      expect(mockStateTransitionService.transition).not.toHaveBeenCalled();
      expect(mockRedisClient.del).toHaveBeenCalledWith('ag:idle:seq:9999');
    });
  });
});
