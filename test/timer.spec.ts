/**
 * @file timer.spec.ts
 * @description 静默与熔断双计时器单元测试 (TimerService)
 */

import { TimerService } from '../src/modules/pipeline/timer.service';
import type { Env } from '../src/config/env';

describe('双计时器调度服务测试 (TimerService)', () => {
  let service: TimerService;
  let mockQueueService: any;
  let mockBufferService: any;
  let mockTimerQueue: any;
  let mockSealer: any;

  const mockEnv: Env = {
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
  };

  beforeEach(() => {
    mockTimerQueue = {
      add: jest.fn().mockResolvedValue({ id: 'job_test' }),
    };

    mockQueueService = {
      getQueue: jest.fn().mockReturnValue(mockTimerQueue),
      createWorker: jest.fn(),
    };

    mockBufferService = {
      getMeta: jest.fn(),
    };

    mockSealer = {
      seal: jest.fn().mockResolvedValue({ success: true }),
    };

    service = new TimerService(mockEnv, mockQueueService, mockBufferService);
    service.setSealer(mockSealer);
  });

  describe('1. 任务调度 (scheduleQuiet & scheduleHard)', () => {
    it('scheduleQuiet 应使用版本号构造 jobId 并设置 3000ms 延迟', async () => {
      await service.scheduleQuiet(101, 'user_zhang', 3);

      expect(mockQueueService.getQueue).toHaveBeenCalledWith('agent.queue.timer');
      expect(mockTimerQueue.add).toHaveBeenCalledWith(
        'quiet',
        {
          type: 'quiet',
          convId: 101,
          senderId: 'user_zhang',
          version: 3,
        },
        expect.objectContaining({
          jobId: 'quiet:101:user_zhang@3',
          delay: 3000,
        }),
      );
    });

    it('scheduleHard 应使用 epoch 构造 jobId 并设置 15000ms 延迟', async () => {
      await service.scheduleHard(101, 'user_zhang', 1);

      expect(mockTimerQueue.add).toHaveBeenCalledWith(
        'hard',
        {
          type: 'hard',
          convId: 101,
          senderId: 'user_zhang',
          epoch: 1,
        },
        expect.objectContaining({
          jobId: 'hard:101:user_zhang@1',
          delay: 15000,
        }),
      );
    });
  });

  describe('2. 任务消费比对 (handleTimerJob)', () => {
    it('静默任务触发时，若版本号与当前一致则触发封组', async () => {
      mockBufferService.getMeta.mockResolvedValue({
        count: 2,
        version: 3,
        epoch: 1,
      });

      const mockJob: any = {
        data: {
          type: 'quiet',
          convId: 101,
          senderId: 'user_zhang',
          version: 3,
        },
      };

      await service.handleTimerJob(mockJob);

      expect(mockSealer.seal).toHaveBeenCalledWith(101, 'user_zhang', 'QUIET');
    });

    it('静默任务触发时，若版本号不一致（客户又发了新消息）则安全丢弃不触发封组', async () => {
      mockBufferService.getMeta.mockResolvedValue({
        count: 3,
        version: 4, // 已经变成 4
        epoch: 1,
      });

      const mockJob: any = {
        data: {
          type: 'quiet',
          convId: 101,
          senderId: 'user_zhang',
          version: 3, // 旧版本 3
        },
      };

      await service.handleTimerJob(mockJob);

      expect(mockSealer.seal).not.toHaveBeenCalled();
    });

    it('熔断任务触发时，若 epoch 一致则强制触发封组', async () => {
      mockBufferService.getMeta.mockResolvedValue({
        count: 4,
        version: 5,
        epoch: 2,
      });

      const mockJob: any = {
        data: {
          type: 'hard',
          convId: 101,
          senderId: 'user_zhang',
          epoch: 2,
        },
      };

      await service.handleTimerJob(mockJob);

      expect(mockSealer.seal).toHaveBeenCalledWith(101, 'user_zhang', 'HARD');
    });

    it('熔断任务触发时，若 epoch 已变更（已被静默或条数封组）则安全丢弃', async () => {
      mockBufferService.getMeta.mockResolvedValue({
        count: 1,
        version: 1,
        epoch: 3, // 已更新为新轮次 3
      });

      const mockJob: any = {
        data: {
          type: 'hard',
          convId: 101,
          senderId: 'user_zhang',
          epoch: 2, // 旧轮次 2
        },
      };

      await service.handleTimerJob(mockJob);

      expect(mockSealer.seal).not.toHaveBeenCalled();
    });
  });
});
