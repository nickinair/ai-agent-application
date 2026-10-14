/**
 * @file microphone.service.ts
 * @description 智能体全能平台会话发言权（话筒）原子管理器（Redis Lua 原子状态切换 + 版本号管理 + MySQL 持久化同步）
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §6.2 话筒抢夺与交还机制、§7.1 Redis Key 设计、附录 C (S7, S8, S9, S21)
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, type Env } from '../../config/env';
import { MysqlService } from '../../database/mysql.service';
import { RedisService } from '../../infra/redis/redis.service';
import { REDIS_KEYS } from '../../infra/redis/redis.keys';

export interface MicrophoneStatus {
  owner: 'BOT' | 'HUMAN';
  since: number;
  staffId: string;
  reason: string;
  epoch: number;
  isHandoffLocked: boolean;
}

export interface MicrophoneSeizeResult {
  changed: boolean;
  owner: 'BOT' | 'HUMAN';
  prevOwner: 'BOT' | 'HUMAN';
  epoch: number;
  staffId: string;
  reason: string;
}

@Injectable()
export class MicrophoneService {
  private readonly logger = new Logger(MicrophoneService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly mysqlService: MysqlService,
    private readonly redisService: RedisService,
  ) {}

  /**
   * 获取当前会话的话筒状态（若未初始化则懒加载为 BOT 持有）
   */
  async getMicStatus(convId: number | string): Promise<MicrophoneStatus> {
    const redis = this.redisService.getClient();
    const micKey = REDIS_KEYS.mic(convId);
    const data = await redis.hgetall(micKey);

    if (!data || Object.keys(data).length === 0) {
      // 默认初始化为 BOT
      const now = Date.now();
      const initial: Record<string, string> = {
        owner: 'BOT',
        since: String(now),
        staffId: '',
        reason: 'INIT',
        epoch: '1',
        is_handoff_locked: '0',
      };
      await redis.hset(micKey, initial);
      return {
        owner: 'BOT',
        since: now,
        staffId: '',
        reason: 'INIT',
        epoch: 1,
        isHandoffLocked: false,
      };
    }

    return {
      owner: (data.owner as 'BOT' | 'HUMAN') || 'BOT',
      since: parseInt(data.since || '0', 10),
      staffId: data.staffId || '',
      reason: data.reason || '',
      epoch: parseInt(data.epoch || '1', 10),
      isHandoffLocked: data.is_handoff_locked === '1',
    };
  }

  /**
   * 员工发言触发抢占话筒（Lua 脚本原子抢占）
   * @param convId 会话 ID
   * @param staffId 员工渠道 ID
   * @param role 员工角色 (STAFF_CS / STAFF_OTHER)
   * @param reason 抢占原因
   */
  async seizeByStaff(
    convId: number | string,
    staffId: string,
    role: string,
    reason = 'STAFF_SEIZED',
  ): Promise<MicrophoneSeizeResult> {
    const redis = this.redisService.getClient();
    const micKey = REDIS_KEYS.mic(convId);
    const now = Date.now();

    // Lua 脚本执行原子状态迁移与 epoch 递增
    const luaScript = `
      local currentOwner = redis.call("hget", KEYS[1], "owner") or "BOT"
      local currentStaff = redis.call("hget", KEYS[1], "staffId") or ""
      local currentEpoch = tonumber(redis.call("hget", KEYS[1], "epoch") or "0")
      local isLocked = redis.call("hget", KEYS[1], "is_handoff_locked") or "0"

      local changed = 0
      local newEpoch = currentEpoch

      if currentOwner == "BOT" or currentStaff ~= ARGV[1] then
        changed = 1
        newEpoch = currentEpoch + 1
        redis.call("hset", KEYS[1], "owner", "HUMAN")
        redis.call("hset", KEYS[1], "staffId", ARGV[1])
        redis.call("hset", KEYS[1], "since", ARGV[2])
        redis.call("hset", KEYS[1], "reason", ARGV[3])
        redis.call("hset", KEYS[1], "epoch", tostring(newEpoch))
      else
        -- 同一坐席连续发言，仅刷新活跃时间戳
        redis.call("hset", KEYS[1], "since", ARGV[2])
      end

      return {changed, currentOwner, "HUMAN", newEpoch, ARGV[1], ARGV[3]}
    `;

    const res = (await redis.eval(
      luaScript,
      1,
      micKey,
      staffId,
      String(now),
      reason,
    )) as [number, string, string, number, string, string];

    const changed = res[0] === 1;
    const prevOwner = (res[1] as 'BOT' | 'HUMAN') || 'BOT';
    const owner = (res[2] as 'BOT' | 'HUMAN') || 'HUMAN';
    const epoch = res[3];

    if (changed) {
      this.logger.log(
        `🎙️ [Microphone] 话筒被抢占: convId=${convId}, staffId=${staffId} (${role}), epoch=${epoch}, prev=${prevOwner} -> now=HUMAN`,
      );
      // 伴随异步持久化至 MySQL conversation 表
      await this.syncToDatabase(convId, 'HUMAN');
    }

    return {
      changed,
      owner,
      prevOwner,
      epoch,
      staffId,
      reason,
    };
  }

  /**
   * 将话筒交还给 BOT（超时接回或手动释放）
   * @param convId 会话 ID
   * @param reason 交还原因 (TIMEOUT_RETURN / MANUAL_RETURN 等)
   * @param force 是否强制（若处于 AI 主动转人工锁定状态，默认非强制无法接回）
   */
  async returnToBot(
    convId: number | string,
    reason = 'TIMEOUT_RETURN',
    force = false,
  ): Promise<{ success: boolean; epoch: number; reason?: string }> {
    const redis = this.redisService.getClient();
    const micKey = REDIS_KEYS.mic(convId);
    const now = Date.now();

    const luaScript = `
      local currentOwner = redis.call("hget", KEYS[1], "owner") or "BOT"
      local currentEpoch = tonumber(redis.call("hget", KEYS[1], "epoch") or "0")
      local isLocked = redis.call("hget", KEYS[1], "is_handoff_locked") or "0"

      if isLocked == "1" and ARGV[3] == "0" then
        return {0, currentEpoch, "HANDOFF_LOCKED"}
      end

      if currentOwner == "BOT" then
        return {1, currentEpoch, "ALREADY_BOT"}
      end

      local newEpoch = currentEpoch + 1
      redis.call("hset", KEYS[1], "owner", "BOT")
      redis.call("hset", KEYS[1], "staffId", "")
      redis.call("hset", KEYS[1], "since", ARGV[1])
      redis.call("hset", KEYS[1], "reason", ARGV[2])
      redis.call("hset", KEYS[1], "epoch", tostring(newEpoch))
      redis.call("hset", KEYS[1], "is_handoff_locked", "0")

      return {1, newEpoch, "RETURNED"}
    `;

    const res = (await redis.eval(
      luaScript,
      1,
      micKey,
      String(now),
      reason,
      force ? '1' : '0',
    )) as [number, number, string];

    const success = res[0] === 1;
    const epoch = res[1];
    const returnMsg = res[2];

    if (success && returnMsg === 'RETURNED') {
      this.logger.log(
        `🤖 [Microphone] 话筒已交还给 BOT: convId=${convId}, reason=${reason}, epoch=${epoch}`,
      );
      await this.syncToDatabase(convId, 'BOT');
    } else if (!success) {
      this.logger.warn(
        `🔒 [Microphone] 话筒交还被拒绝 (锁定状态): convId=${convId}, status=${returnMsg}`,
      );
    }

    return { success, epoch, reason: returnMsg };
  }

  /**
   * AI 主动转人工锁定话筒（转人工后禁止 60s 自动接回）
   */
  async lockHandoff(
    convId: number | string,
    staffId = '',
    reason = 'AI_HANDOFF',
  ): Promise<MicrophoneStatus> {
    const redis = this.redisService.getClient();
    const micKey = REDIS_KEYS.mic(convId);
    const now = Date.now();

    const luaScript = `
      local currentEpoch = tonumber(redis.call("hget", KEYS[1], "epoch") or "0")
      local newEpoch = currentEpoch + 1
      redis.call("hset", KEYS[1], "owner", "HUMAN")
      redis.call("hset", KEYS[1], "staffId", ARGV[1])
      redis.call("hset", KEYS[1], "since", ARGV[2])
      redis.call("hset", KEYS[1], "reason", ARGV[3])
      redis.call("hset", KEYS[1], "epoch", tostring(newEpoch))
      redis.call("hset", KEYS[1], "is_handoff_locked", "1")

      return newEpoch
    `;

    const newEpoch = (await redis.eval(
      luaScript,
      1,
      micKey,
      staffId,
      String(now),
      reason,
    )) as number;

    this.logger.log(
      `🔒 [Microphone] AI 主动转人工，锁定话筒为 HUMAN 且禁止自动接回: convId=${convId}, epoch=${newEpoch}`,
    );
    await this.syncToDatabase(convId, 'HUMAN', true);

    return {
      owner: 'HUMAN',
      since: now,
      staffId,
      reason,
      epoch: newEpoch,
      isHandoffLocked: true,
    };
  }

  /**
   * 客服在群内 @机器人 显式交还话筒
   */
  async returnByMention(
    convId: number | string,
    staffId: string,
  ): Promise<{ success: boolean; epoch: number; reason?: string }> {
    this.logger.log(
      `🛎️ [Microphone] 客服 @机器人 显式交还话筒: convId=${convId}, staffId=${staffId}`,
    );
    // 显式交还视为强制解锁
    return await this.returnToBot(convId, 'MENTION_RETURN', true);
  }

  /**
   * 检查当前会话话筒是否在 BOT 手中
   */
  async isHeldByBot(convId: number | string): Promise<boolean> {
    const status = await this.getMicStatus(convId);
    return status.owner === 'BOT';
  }

  /**
   * 检查当前会话话筒是否在 HUMAN 手中
   */
  async isHeldByHuman(convId: number | string): Promise<boolean> {
    const status = await this.getMicStatus(convId);
    return status.owner === 'HUMAN';
  }

  /**
   * 同步更新 MySQL conversation 表
   */
  private async syncToDatabase(
    convId: number | string,
    owner: 'BOT' | 'HUMAN',
    handoff?: boolean,
  ): Promise<void> {
    try {
      const pool = this.mysqlService.getPool();
      let sql = `UPDATE conversation SET mic_owner = ?`;
      const params: unknown[] = [owner];

      if (handoff !== undefined) {
        sql += `, handoff = ?, handoff_at = NOW(3)`;
        params.push(handoff ? 1 : 0);
      }

      sql += ` WHERE id = ?`;
      params.push(convId);

      await pool.query(sql, params);
    } catch (err: any) {
      this.logger.error(
        `[Microphone] 同步话筒状态至 MySQL 失败 (convId=${convId}): ${err.message}`,
        err.stack,
      );
    }
  }
}
