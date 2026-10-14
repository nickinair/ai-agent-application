/**
 * @file redis.spec.ts
 * @description Redis 客户端与分布式锁单元测试
 */

import { RedisService } from '../src/infra/redis/redis.service';
import { REDIS_KEYS } from '../src/infra/redis/redis.keys';
import type { Env } from '../src/config/env';

describe('Redis 基础设施与分布式锁测试 (RedisService)', () => {
  let redisService: RedisService;
  let mockRedisClient: any;

  const mockEnv: Env = {
    PORT: 3002,
    MYSQL_URL: 'mysql://localhost:3306/test',
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
    mockRedisClient = {
      set: jest.fn(),
      eval: jest.fn(),
      quit: jest.fn().mockResolvedValue('OK'),
      on: jest.fn(),
    };

    redisService = new RedisService(mockEnv);
    (redisService as any).client = mockRedisClient;
  });

  describe('1. Key 命名规范验证', () => {
    it('REDIS_KEYS 生成的键符合 §7.1 技术方案', () => {
      expect(REDIS_KEYS.buffer(101, 'user_1')).toBe('ag:buf:101:user_1');
      expect(REDIS_KEYS.bufferMeta(101, 'user_1')).toBe('ag:bufmeta:101:user_1');
      expect(REDIS_KEYS.convLock(101)).toBe('ag:lock:conv:101');
      expect(REDIS_KEYS.mic(101)).toBe('ag:mic:101');
      expect(REDIS_KEYS.inflight(101)).toBe('ag:inflight:101');
    });
  });

  describe('2. 分布式排他锁 (acquireLock)', () => {
    it('当 Redis SET NX 成功时成功返回锁控制句柄', async () => {
      mockRedisClient.set.mockResolvedValue('OK');

      const lock = await redisService.acquireLock('ag:lock:conv:101', 5000);

      expect(lock).not.toBeNull();
      expect(lock?.token).toBeDefined();
      expect(mockRedisClient.set).toHaveBeenCalledWith(
        'ag:lock:conv:101',
        lock?.token,
        'PX',
        5000,
        'NX',
      );
    });

    it('当已被其他实例持有锁时返回 null', async () => {
      mockRedisClient.set.mockResolvedValue(null);

      const lock = await redisService.acquireLock('ag:lock:conv:101', 5000);

      expect(lock).toBeNull();
    });

    it('释放锁时仅在 Token 匹配时成功删除 (Lua eval)', async () => {
      mockRedisClient.set.mockResolvedValue('OK');
      mockRedisClient.eval.mockResolvedValue(1);

      const lock = await redisService.acquireLock('ag:lock:conv:101', 5000);
      const released = await lock!.release();

      expect(released).toBe(true);
      expect(mockRedisClient.eval).toHaveBeenCalled();
    });

    it('续期锁时执行 pexpire (Lua eval)', async () => {
      mockRedisClient.set.mockResolvedValue('OK');
      mockRedisClient.eval.mockResolvedValue(1);

      const lock = await redisService.acquireLock('ag:lock:conv:101', 5000);
      const renewed = await lock!.renew(8000);

      expect(renewed).toBe(true);
      expect(mockRedisClient.eval).toHaveBeenCalled();
    });
  });
});
