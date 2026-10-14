/**
 * @file state-transition.service.ts
 * @description 智能体全能平台核心三层状态机流转服务（乐观锁并发控制 + 状态转移守卫 + 审计日志伴随落库）
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §6.1 状态定义与流转、§12 数据库设计 DDL
 */

import { Injectable, Logger } from '@nestjs/common';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { ConversationStatus, GroupStatus, TurnStatus } from '../../contracts';
import { MysqlService } from '../../database/mysql.service';

export type EntityType = 'CONVERSATION' | 'TURN' | 'GROUP';

export type EntityStatus<T extends EntityType> =
  T extends 'CONVERSATION' ? ConversationStatus :
  T extends 'TURN' ? TurnStatus :
  T extends 'GROUP' ? GroupStatus :
  string;

export interface TransitionOptions {
  tenantId?: number | string;
  traceId?: string;
  operatorType?: 'SYSTEM' | 'STAFF' | 'TIMEOUT' | 'CUSTOMER';
  reason?: string;
  metadata?: Record<string, unknown>;
}

/**
 * 非法状态流转异常
 */
export class IllegalStateTransitionException extends Error {
  constructor(
    public readonly entityType: EntityType,
    public readonly entityId: string | number,
    public readonly fromStatus: string,
    public readonly toStatus: string,
  ) {
    super(
      `[StateTransition] 非法状态流转: ${entityType} #${entityId} 不能从 ${fromStatus} 跃迁至 ${toStatus}`,
    );
    this.name = 'IllegalStateTransitionException';
  }
}

/**
 * 乐观锁并发冲突异常
 */
export class OptimisticLockConflictException extends Error {
  constructor(
    public readonly entityType: EntityType,
    public readonly entityId: string | number,
    public readonly fromStatus: string,
    public readonly toStatus: string,
  ) {
    super(
      `[StateTransition] 乐观锁并发冲突: ${entityType} #${entityId} 状态已不再是 ${fromStatus} (可能已被其他并发修改)，跃迁至 ${toStatus} 失败`,
    );
    this.name = 'OptimisticLockConflictException';
  }
}

/**
 * 合法状态跃迁矩阵守卫字典
 */
export const VALID_TRANSITIONS: Record<EntityType, Record<string, string[]>> = {
  CONVERSATION: {
    QUEUED: ['ACTIVE', 'ENDED'],
    ACTIVE: ['ENDED'],
  },
  TURN: {
    IN_PROGRESS: ['DONE'],
  },
  GROUP: {
    COLLECTING: ['UNDERSTANDING', 'ARCHIVED'],
    UNDERSTANDING: ['FINAL_CHECKING', 'SENT', 'VOIDED'],
    FINAL_CHECKING: ['UNDERSTANDING', 'SENT', 'VOIDED'],
  },
};

const TABLE_MAP: Record<EntityType, { table: string; logType: string }> = {
  CONVERSATION: { table: 'conversation', logType: 'conversation' },
  TURN: { table: 'turn', logType: 'turn' },
  GROUP: { table: 'msg_group', logType: 'group' },
};

@Injectable()
export class StateTransitionService {
  private readonly logger = new Logger(StateTransitionService.name);

  constructor(private readonly mysql: MysqlService) {}

  /**
   * 检查状态跃迁是否合法
   */
  isValidTransition(entityType: EntityType, fromStatus: string, toStatus: string): boolean {
    const entityTransitions = VALID_TRANSITIONS[entityType];
    if (!entityTransitions) return false;
    const allowedTargets = entityTransitions[fromStatus];
    if (!allowedTargets) return false;
    return allowedTargets.includes(toStatus);
  }

  /**
   * 执行带乐观锁条件的状态跃迁，并在成功后持久化流转审计日志
   *
   * @throws IllegalStateTransitionException 若跃迁违反状态机守卫矩阵
   * @throws OptimisticLockConflictException 若当前状态已被其他并发操作修改
   */
  async transition<T extends EntityType>(
    entityType: T,
    entityId: string | number,
    fromStatus: EntityStatus<T>,
    toStatus: EntityStatus<T>,
    options?: TransitionOptions,
  ): Promise<void> {
    const tracePrefix = options?.traceId ? `[${options.traceId}] ` : '';

    // 1. 内存状态机守卫校验（防御性编程，杜绝脏状态）
    if (!this.isValidTransition(entityType, fromStatus, toStatus)) {
      this.logger.error(
        `${tracePrefix}非法状态流转拒绝: ${entityType} #${entityId} [${fromStatus} -> ${toStatus}]`,
      );
      throw new IllegalStateTransitionException(entityType, entityId, fromStatus, toStatus);
    }

    const { table, logType } = TABLE_MAP[entityType];
    const pool = this.mysql.getPool();

    // 2. 构造乐观锁条件更新 SQL
    let updateSql = `UPDATE ${table} SET status = ?`;
    const params: unknown[] = [toStatus];

    if (entityType === 'CONVERSATION' && toStatus === 'ENDED') {
      updateSql += ', ended_at = NOW(3)';
      if (options?.reason) {
        updateSql += ', end_reason = ?';
        params.push(options.reason);
      }
    } else if (entityType === 'TURN' && toStatus === 'DONE') {
      updateSql += ', finished_at = NOW(3)';
    }

    updateSql += ' WHERE id = ? AND status = ?';
    params.push(entityId, fromStatus);

    if (options?.tenantId !== undefined && options?.tenantId !== null) {
      updateSql += ' AND tenant_id = ?';
      params.push(options.tenantId);
    }

    // 3. 执行更新并验证 affectedRows
    const [result] = await pool.query<ResultSetHeader>(updateSql, params);

    if (result.affectedRows === 0) {
      this.logger.warn(
        `${tracePrefix}乐观锁并发冲突拦截: ${entityType} #${entityId} 当前状态已非 ${fromStatus}，目标状态 ${toStatus} 流转失败`,
      );
      throw new OptimisticLockConflictException(entityType, entityId, fromStatus, toStatus);
    }

    this.logger.log(
      `${tracePrefix}状态跃迁成功: ${entityType} #${entityId} [${fromStatus} -> ${toStatus}]`,
    );

    // 4. 伴随记录持久化审计日志 (state_transition_log)
    try {
      let tenantIdToLog = options?.tenantId;
      if (tenantIdToLog === undefined || tenantIdToLog === null) {
        // 若未传入 tenantId，尝试从实体表中查出
        const [rows] = await pool.query<RowDataPacket[]>(
          `SELECT tenant_id FROM ${table} WHERE id = ? LIMIT 1`,
          [entityId],
        );
        tenantIdToLog = rows[0]?.tenant_id ?? 1;
      }

      await pool.query(
        `INSERT INTO state_transition_log 
         (tenant_id, entity_type, entity_id, from_state, to_state, reason, trace_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW(3))`,
        [
          tenantIdToLog,
          logType,
          entityId,
          fromStatus,
          toStatus,
          options?.reason ?? null,
          options?.traceId ?? null,
        ],
      );
    } catch (logErr) {
      // 审计日志写入异常不回滚业务流转，但需记录严重告警
      this.logger.error(
        `${tracePrefix}状态流转审计日志写入失败: ${entityType} #${entityId} [${fromStatus} -> ${toStatus}]: ${(logErr as Error).message}`,
        (logErr as Error).stack,
      );
    }
  }
}
