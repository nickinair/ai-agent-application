/**
 * @file state-transition.spec.ts
 * @description 智能体全能平台核心状态流转服务单元测试 (StateTransitionService)
 */

import {
  StateTransitionService,
  IllegalStateTransitionException,
  OptimisticLockConflictException,
  VALID_TRANSITIONS,
} from '../src/modules/pipeline/state-transition.service';
import type { MysqlService } from '../src/database/mysql.service';

describe('状态流转服务测试 (StateTransitionService)', () => {
  let service: StateTransitionService;
  let mockDbPool: any;
  let mockMysqlService: any;

  beforeEach(() => {
    mockDbPool = {
      query: jest.fn(),
    };

    mockMysqlService = {
      getPool: jest.fn().mockReturnValue(mockDbPool),
    } as unknown as MysqlService;

    service = new StateTransitionService(mockMysqlService);
  });

  describe('1. 状态机守卫校验 (isValidTransition)', () => {
    it('合法会话跃迁: QUEUED -> ACTIVE, ACTIVE -> ENDED 返回 true', () => {
      expect(service.isValidTransition('CONVERSATION', 'QUEUED', 'ACTIVE')).toBe(true);
      expect(service.isValidTransition('CONVERSATION', 'ACTIVE', 'ENDED')).toBe(true);
    });

    it('非法会话跃迁: ENDED -> ACTIVE, ACTIVE -> QUEUED 返回 false', () => {
      expect(service.isValidTransition('CONVERSATION', 'ENDED', 'ACTIVE')).toBe(false);
      expect(service.isValidTransition('CONVERSATION', 'ACTIVE', 'QUEUED')).toBe(false);
    });

    it('合法消息组跃迁: COLLECTING -> UNDERSTANDING -> FINAL_CHECKING -> SENT 返回 true', () => {
      expect(service.isValidTransition('GROUP', 'COLLECTING', 'UNDERSTANDING')).toBe(true);
      expect(service.isValidTransition('GROUP', 'COLLECTING', 'ARCHIVED')).toBe(true);
      expect(service.isValidTransition('GROUP', 'UNDERSTANDING', 'FINAL_CHECKING')).toBe(true);
      expect(service.isValidTransition('GROUP', 'UNDERSTANDING', 'VOIDED')).toBe(true);
      expect(service.isValidTransition('GROUP', 'UNDERSTANDING', 'SENT')).toBe(true);
      expect(service.isValidTransition('GROUP', 'FINAL_CHECKING', 'UNDERSTANDING')).toBe(true);
      expect(service.isValidTransition('GROUP', 'FINAL_CHECKING', 'SENT')).toBe(true);
      expect(service.isValidTransition('GROUP', 'FINAL_CHECKING', 'VOIDED')).toBe(true);
    });

    it('非法消息组跃迁: COLLECTING 直接跳 SENT，抛出异常且不执行 SQL', async () => {
      expect(service.isValidTransition('GROUP', 'COLLECTING', 'SENT')).toBe(false);

      await expect(
        service.transition('GROUP', 101, 'COLLECTING', 'SENT' as any),
      ).rejects.toThrow(IllegalStateTransitionException);

      expect(mockDbPool.query).not.toHaveBeenCalled();
    });

    it('非法轮次跃迁: DONE 跳回 IN_PROGRESS 抛出异常', async () => {
      expect(service.isValidTransition('TURN', 'DONE', 'IN_PROGRESS')).toBe(false);

      await expect(
        service.transition('TURN', 201, 'DONE' as any, 'IN_PROGRESS' as any),
      ).rejects.toThrow(IllegalStateTransitionException);

      expect(mockDbPool.query).not.toHaveBeenCalled();
    });
  });

  describe('2. 数据库乐观锁更新与影响行数校验', () => {
    it('Group COLLECTING -> UNDERSTANDING 正常流转并更新状态', async () => {
      // Mock UPDATE 影响 1 行
      mockDbPool.query
        .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE
        .mockResolvedValueOnce([{ insertId: 1 }]); // INSERT log

      await service.transition('GROUP', 501, 'COLLECTING', 'UNDERSTANDING', {
        tenantId: 1,
        traceId: 'trace-test-1',
        reason: 'QUIET_TIMEOUT',
      });

      expect(mockDbPool.query).toHaveBeenCalledTimes(2);

      const [updateSql, updateParams] = mockDbPool.query.mock.calls[0];
      expect(updateSql).toContain('UPDATE msg_group SET status = ?');
      expect(updateSql).toContain('WHERE id = ? AND status = ? AND tenant_id = ?');
      expect(updateParams).toEqual(['UNDERSTANDING', 501, 'COLLECTING', 1]);
    });

    it('Conversation ACTIVE -> ENDED 正确更新 ended_at 与 end_reason', async () => {
      mockDbPool.query
        .mockResolvedValueOnce([{ affectedRows: 1 }])
        .mockResolvedValueOnce([{ insertId: 2 }]);

      await service.transition('CONVERSATION', 1001, 'ACTIVE', 'ENDED', {
        tenantId: 1,
        reason: 'IDLE_TIMEOUT',
      });

      const [updateSql, updateParams] = mockDbPool.query.mock.calls[0];
      expect(updateSql).toContain('ended_at = NOW(3)');
      expect(updateSql).toContain('end_reason = ?');
      expect(updateParams).toEqual(['ENDED', 'IDLE_TIMEOUT', 1001, 'ACTIVE', 1]);
    });

    it('Turn IN_PROGRESS -> DONE 正确更新 finished_at', async () => {
      mockDbPool.query
        .mockResolvedValueOnce([{ affectedRows: 1 }])
        .mockResolvedValueOnce([{ insertId: 3 }]);

      await service.transition('TURN', 2001, 'IN_PROGRESS', 'DONE', {
        tenantId: 1,
      });

      const [updateSql, updateParams] = mockDbPool.query.mock.calls[0];
      expect(updateSql).toContain('finished_at = NOW(3)');
      expect(updateParams).toEqual(['DONE', 2001, 'IN_PROGRESS', 1]);
    });

    it('并发冲突: affectedRows === 0 时抛出 OptimisticLockConflictException', async () => {
      // 模拟并发更新导致当前状态不匹配
      mockDbPool.query.mockResolvedValueOnce([{ affectedRows: 0 }]);

      await expect(
        service.transition('GROUP', 502, 'UNDERSTANDING', 'FINAL_CHECKING', {
          tenantId: 1,
        }),
      ).rejects.toThrow(OptimisticLockConflictException);

      // 日志插入不应执行
      expect(mockDbPool.query).toHaveBeenCalledTimes(1);
    });
  });

  describe('3. 伴随写入流转审计日志 (state_transition_log)', () => {
    it('状态跃迁成功后，准确向 state_transition_log 插入记录', async () => {
      mockDbPool.query
        .mockResolvedValueOnce([{ affectedRows: 1 }])
        .mockResolvedValueOnce([{ insertId: 88 }]);

      await service.transition('GROUP', 601, 'FINAL_CHECKING', 'SENT', {
        tenantId: 2,
        traceId: 'trace-sent-99',
        reason: 'PASSED_FINAL_CHECK',
      });

      expect(mockDbPool.query).toHaveBeenCalledTimes(2);

      const [logSql, logParams] = mockDbPool.query.mock.calls[1];
      expect(logSql).toContain('INSERT INTO state_transition_log');
      expect(logParams).toEqual([
        2, // tenant_id
        'group', // entity_type
        601, // entity_id
        'FINAL_CHECKING', // from_state
        'SENT', // to_state
        'PASSED_FINAL_CHECK', // reason
        'trace-sent-99', // trace_id
      ]);
    });

    it('未显式传入 tenantId 时，自动从数据库实体表反查 tenant_id', async () => {
      mockDbPool.query
        .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE
        .mockResolvedValueOnce([[{ tenant_id: 10 }]]) // SELECT tenant_id
        .mockResolvedValueOnce([{ insertId: 99 }]); // INSERT log

      await service.transition('CONVERSATION', 801, 'QUEUED', 'ACTIVE');

      expect(mockDbPool.query).toHaveBeenCalledTimes(3);

      const [querySql] = mockDbPool.query.mock.calls[1];
      expect(querySql).toContain('SELECT tenant_id FROM conversation WHERE id = ?');

      const [, logParams] = mockDbPool.query.mock.calls[2];
      expect(logParams[0]).toBe(10);
    });

    it('审计日志插入失败不应影响主业务状态更新结果', async () => {
      mockDbPool.query
        .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE 成功
        .mockRejectedValueOnce(new Error('DB log disk full')); // INSERT log 失败

      // 应当顺利 resolve，不抛出异常
      await expect(
        service.transition('GROUP', 701, 'UNDERSTANDING', 'VOIDED', {
          tenantId: 1,
          reason: 'MIC_SEIZED',
        }),
      ).resolves.not.toThrow();
    });
  });
});
