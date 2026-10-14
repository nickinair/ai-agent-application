/**
 * @file microphone.spec.ts
 * @description 话筒原子管理器单元测试 (MicrophoneService)
 */

import { MicrophoneService } from '../src/modules/pipeline/microphone.service';
import type { Env } from '../src/config/env';

describe('话筒原子管理器测试 (MicrophoneService)', () => {
  let service: MicrophoneService;
  let mockMysqlService: any;
  let mockRedisService: any;
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
    MIC_SEIZE_SCOPE: 'ALL_INTERNAL',
    MIC_RETURN_BY_MENTION_ENABLED: true,
    HUMAN_WAIT_TIMEOUT_MS: 60000,
  };

  beforeEach(() => {
    mockDbPool = {
      query: jest.fn().mockResolvedValue([{ affectedRows: 1 }]),
    };

    mockMysqlService = {
      getPool: jest.fn().mockReturnValue(mockDbPool),
    };

    mockRedisClient = {
      hgetall: jest.fn(),
      hset: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn(),
    };

    mockRedisService = {
      getClient: jest.fn().mockReturnValue(mockRedisClient),
    };

    service = new MicrophoneService(mockEnv, mockMysqlService, mockRedisService);
  });

  describe('1. 话筒状态查询 (getMicStatus)', () => {
    it('当 Redis 无状态数据时，应懒加载初始化为 BOT 持有并写入 Redis', async () => {
      mockRedisClient.hgetall.mockResolvedValue({});

      const status = await service.getMicStatus(101);

      expect(status.owner).toBe('BOT');
      expect(status.epoch).toBe(1);
      expect(status.isHandoffLocked).toBe(false);
      expect(mockRedisClient.hset).toHaveBeenCalledWith(
        'ag:mic:101',
        expect.objectContaining({
          owner: 'BOT',
          reason: 'INIT',
          epoch: '1',
          is_handoff_locked: '0',
        }),
      );
    });

    it('当 Redis 存在已持有状态时，应正确解析为 MicrophoneStatus 对象', async () => {
      mockRedisClient.hgetall.mockResolvedValue({
        owner: 'HUMAN',
        since: '1700000000000',
        staffId: 'staff_zhang',
        reason: 'STAFF_SEIZED',
        epoch: '3',
        is_handoff_locked: '1',
      });

      const status = await service.getMicStatus(102);

      expect(status.owner).toBe('HUMAN');
      expect(status.staffId).toBe('staff_zhang');
      expect(status.epoch).toBe(3);
      expect(status.isHandoffLocked).toBe(true);
    });
  });

  describe('2. 员工抢占话筒 (seizeByStaff)', () => {
    it('话筒原在 BOT 手中，员工发言抢占应原子变更 owner 为 HUMAN 并递增 epoch 且同步 MySQL', async () => {
      // 模拟 Lua 返回: [changed=1, prevOwner="BOT", nowOwner="HUMAN", newEpoch=2, staffId="staff_001", reason="STAFF_SEIZED"]
      mockRedisClient.eval.mockResolvedValue([1, 'BOT', 'HUMAN', 2, 'staff_001', 'STAFF_SEIZED']);

      const res = await service.seizeByStaff(201, 'staff_001', 'STAFF_CS');

      expect(res.changed).toBe(true);
      expect(res.prevOwner).toBe('BOT');
      expect(res.owner).toBe('HUMAN');
      expect(res.epoch).toBe(2);
      expect(res.staffId).toBe('staff_001');

      // 验证 MySQL 异步持久化
      expect(mockDbPool.query).toHaveBeenCalledWith(
        'UPDATE conversation SET mic_owner = ? WHERE id = ?',
        ['HUMAN', 201],
      );
    });

    it('同一员工连续发言，changed 应为 false，不触发额外 MySQL 更新', async () => {
      // 模拟 Lua 返回: [changed=0, prevOwner="HUMAN", nowOwner="HUMAN", newEpoch=2, staffId="staff_001", reason="STAFF_SEIZED"]
      mockRedisClient.eval.mockResolvedValue([0, 'HUMAN', 'HUMAN', 2, 'staff_001', 'STAFF_SEIZED']);

      const res = await service.seizeByStaff(201, 'staff_001', 'STAFF_CS');

      expect(res.changed).toBe(false);
      expect(res.prevOwner).toBe('HUMAN');
      expect(res.owner).toBe('HUMAN');
      expect(res.epoch).toBe(2);

      // 同一坐席发言不重复更新 MySQL
      expect(mockDbPool.query).not.toHaveBeenCalled();
    });
  });

  describe('3. 交还话筒 (returnToBot)', () => {
    it('正常状态下交还，应将 owner 置为 BOT，递增 epoch 并更新 MySQL', async () => {
      // 模拟 Lua 返回: [success=1, newEpoch=3, msg="RETURNED"]
      mockRedisClient.eval.mockResolvedValue([1, 3, 'RETURNED']);

      const res = await service.returnToBot(301, 'TIMEOUT_RETURN');

      expect(res.success).toBe(true);
      expect(res.epoch).toBe(3);
      expect(res.reason).toBe('RETURNED');
      expect(mockDbPool.query).toHaveBeenCalledWith(
        'UPDATE conversation SET mic_owner = ? WHERE id = ?',
        ['BOT', 301],
      );
    });

    it('处于转人工锁定状态时，非强制 (force=false) 交还应被拒绝', async () => {
      // 模拟 Lua 返回: [success=0, currentEpoch=3, msg="HANDOFF_LOCKED"]
      mockRedisClient.eval.mockResolvedValue([0, 3, 'HANDOFF_LOCKED']);

      const res = await service.returnToBot(301, 'TIMEOUT_RETURN', false);

      expect(res.success).toBe(false);
      expect(res.reason).toBe('HANDOFF_LOCKED');
      expect(mockDbPool.query).not.toHaveBeenCalled();
    });

    it('处于转人工锁定状态时，强制 (force=true) 交还应成功解锁并交还 BOT', async () => {
      mockRedisClient.eval.mockResolvedValue([1, 4, 'RETURNED']);

      const res = await service.returnToBot(301, 'FORCE_UNLOCK', true);

      expect(res.success).toBe(true);
      expect(res.epoch).toBe(4);
      expect(res.reason).toBe('RETURNED');
      expect(mockDbPool.query).toHaveBeenCalledWith(
        'UPDATE conversation SET mic_owner = ? WHERE id = ?',
        ['BOT', 301],
      );
    });
  });

  describe('4. AI 主动转人工锁定与显式交还 (lockHandoff & returnByMention)', () => {
    it('lockHandoff 应原子锁定话筒为 HUMAN 并置 is_handoff_locked=1 同步更新 DB handoff 标记', async () => {
      mockRedisClient.eval.mockResolvedValue(5);

      const status = await service.lockHandoff(401, 'staff_007', 'AI_HANDOFF');

      expect(status.owner).toBe('HUMAN');
      expect(status.isHandoffLocked).toBe(true);
      expect(status.epoch).toBe(5);
      expect(mockDbPool.query).toHaveBeenCalledWith(
        'UPDATE conversation SET mic_owner = ?, handoff = ?, handoff_at = NOW(3) WHERE id = ?',
        ['HUMAN', 1, 401],
      );
    });

    it('returnByMention 应调用带有 force=true 的 returnToBot 实施解锁交还', async () => {
      mockRedisClient.eval.mockResolvedValue([1, 6, 'RETURNED']);

      const res = await service.returnByMention(401, 'staff_007');

      expect(res.success).toBe(true);
      expect(res.epoch).toBe(6);
    });
  });

  describe('5. 持有者判定 (isHeldByBot & isHeldByHuman)', () => {
    it('isHeldByBot 应返回正确布尔值', async () => {
      mockRedisClient.hgetall.mockResolvedValue({ owner: 'BOT', epoch: '1' });
      expect(await service.isHeldByBot(501)).toBe(true);

      mockRedisClient.hgetall.mockResolvedValue({ owner: 'HUMAN', epoch: '2' });
      expect(await service.isHeldByBot(501)).toBe(false);
    });

    it('isHeldByHuman 应返回正确布尔值', async () => {
      mockRedisClient.hgetall.mockResolvedValue({ owner: 'HUMAN', epoch: '2' });
      expect(await service.isHeldByHuman(501)).toBe(true);

      mockRedisClient.hgetall.mockResolvedValue({ owner: 'BOT', epoch: '1' });
      expect(await service.isHeldByHuman(501)).toBe(false);
    });
  });
});
