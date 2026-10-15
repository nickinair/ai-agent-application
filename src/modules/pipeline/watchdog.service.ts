/**
 * @file watchdog.service.ts
 * @description 智能体全能平台崩溃与在途组扫描看门狗服务 (S18 用例)
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §7.1、§16.2 可靠性与降级、S18 用例
 */

import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { ENV, type Env } from '../../config/env';
import { MysqlService } from '../../database/mysql.service';
import { RedisService } from '../../infra/redis/redis.service';
import { REDIS_KEYS } from '../../infra/redis/redis.keys';
import { StateTransitionService } from './state-transition.service';
import { SealerService } from './sealer.service';
import { CHANNEL_ADAPTER, type ChannelAdapter, type ChannelType } from '../../contracts';

export interface WatchdogScanReport {
  scanned: number;
  recovered: number;
  clearedStale: number;
  skipped: number;
}

export interface InflightData {
  groupId?: string;
  sealedAt?: string;
  turnId?: string;
  status?: string;
}

@Injectable()
export class WatchdogService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WatchdogService.name);

  /** 在途超时判定时限（默认 8000ms，根据 PRD S18 用例规范） */
  private timeoutMs = 8000;

  /** 周期巡检间隔（默认 5000ms） */
  private scanIntervalMs = 5000;

  /** 兜底友好回复文案 */
  private fallbackText = '网络繁忙，稍后为您服务';

  /** 巡检定时器句柄 */
  private timer: NodeJS.Timeout | null = null;

  /** 防重入扫描标记 */
  private isScanning = false;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly mysqlService: MysqlService,
    private readonly redisService: RedisService,
    private readonly stateTransitionService: StateTransitionService,
    @Optional() private readonly sealerService?: SealerService,
    @Optional() @Inject(CHANNEL_ADAPTER) private readonly channelAdapter?: ChannelAdapter,
  ) {}

  /**
   * 应用启动阶段触发首次在途清理（处理 Worker 崩溃重启遗留的在途死锁）
   */
  async onApplicationBootstrap(): Promise<void> {
    this.logger.log('🚀 WatchdogService 启动，执行首次在途死锁扫描...');
    try {
      const report = await this.scanAndRecover();
      this.logger.log(
        `[WatchdogService] 首次在途扫描完毕: 发现=${report.scanned}, 降级自愈=${report.recovered}, 清理残留=${report.clearedStale}`,
      );
    } catch (err: any) {
      this.logger.error(`[WatchdogService] 首次在途扫描异常: ${err.message}`, err.stack);
    }

    // 启动周期性巡检
    this.timer = setInterval(() => {
      this.scanAndRecover().catch((err: any) => {
        this.logger.error(`[WatchdogService] 周期巡检异常: ${err.message}`, err.stack);
      });
    }, this.scanIntervalMs);

    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  /**
   * 模块销毁时注销定时器
   */
  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.log('[WatchdogService] 周期巡检定时器已销毁');
    }
  }

  /**
   * 动态设置超时阈值（用于单测与环境定制）
   */
  setTimeoutMs(ms: number): void {
    this.timeoutMs = ms;
  }

  /**
   * 动态设置兜底话术
   */
  setFallbackText(text: string): void {
    this.fallbackText = text;
  }

  /**
   * 核心巡检与降级自愈闭环入口
   * @param now 可传入基准时间戳，方便单元测试精确模拟
   */
  async scanAndRecover(now: number = Date.now()): Promise<WatchdogScanReport> {
    if (this.isScanning) {
      this.logger.debug('[WatchdogService] 正在执行前一次扫描，跳过本次触发');
      return { scanned: 0, recovered: 0, clearedStale: 0, skipped: 0 };
    }

    this.isScanning = true;
    const report: WatchdogScanReport = {
      scanned: 0,
      recovered: 0,
      clearedStale: 0,
      skipped: 0,
    };

    try {
      const redis = this.redisService.getClient();
      // 扫描所有在途组键
      const keys = await redis.keys('ag:inflight:*');
      report.scanned = keys.length;

      for (const key of keys) {
        const convId = key.replace('ag:inflight:', '');
        const inflight = (await redis.hgetall(key)) as InflightData;

        if (!inflight || !inflight.groupId || !inflight.sealedAt) {
          // 数据不完整，直接清理损坏的在途键
          await this.cleanupRedisInflightAndLock(convId);
          report.clearedStale++;
          continue;
        }

        const groupId = inflight.groupId;
        const sealedAt = Number(inflight.sealedAt);
        const elapsedMs = now - sealedAt;

        // 未超过超时阈值，正常在途放行
        if (elapsedMs <= this.timeoutMs) {
          report.skipped++;
          continue;
        }

        // 超过超时阈值（8s），进入自愈恢复判断
        await this.handleTimeoutInflight(convId, groupId, elapsedMs, report, inflight.turnId);
      }
    } catch (err: any) {
      this.logger.error(`[WatchdogService] 扫描执行异常: ${err.message}`, err.stack);
    } finally {
      this.isScanning = false;
    }

    return report;
  }

  /**
   * 处理单条超时的在途组
   */
  private async handleTimeoutInflight(
    convId: string,
    groupId: string,
    elapsedMs: number,
    report: WatchdogScanReport,
    turnId?: string,
  ): Promise<void> {
    try {
      // 1. 查询数据库中该组的实际状态
      const pool = this.mysqlService.getPool();
      const [groupRows] = await pool.query<RowDataPacket[]>(
        'SELECT id, tenant_id, conversation_id, status, sender_channel_user_id FROM msg_group WHERE id = ?',
        [groupId],
      );

      if (!groupRows || groupRows.length === 0) {
        // 组不存在，清理孤儿键与会话锁
        this.logger.warn(`[Watchdog] 在途组不存在 (#${groupId})，清理孤立 Redis 状态`);
        await this.cleanupRedisInflightAndLock(convId);
        report.clearedStale++;
        return;
      }

      const group = groupRows[0];
      const currentStatus = group.status;

      // 2. 判断是否属于正在挂死的中间态
      if (currentStatus === 'UNDERSTANDING' || currentStatus === 'FINAL_CHECKING') {
        this.logger.warn(
          `🚨 [S18 降级触发] 检测到在途组卡死: convId=${convId}, groupId=${groupId}, status=${currentStatus}, 耗时=${elapsedMs}ms (> ${this.timeoutMs}ms)`,
        );

        // ① 调用状态机强制流转为 SENT（异常降级态）并记录审计日志
        await this.stateTransitionService.transition(
          'GROUP',
          groupId,
          currentStatus,
          'SENT',
          {
            tenantId: group.tenant_id,
            operatorType: 'TIMEOUT',
            reason: 'WATCHDOG_TIMEOUT_FALLBACK',
            metadata: {
              convId,
              elapsedMs,
              originalStatus: currentStatus,
            },
          },
        );

        // ② 查询会话渠道信息并写入降级友好回复消息
        const [convRows] = await pool.query<RowDataPacket[]>(
          'SELECT channel, channel_chat_id FROM conversation WHERE id = ?',
          [convId],
        );
        const channel = convRows?.[0]?.channel || 'wecom';

        const fallbackChannelMsgId = `fallback_${Date.now()}_${randomUUID().slice(0, 8)}`;
        await pool.query(
          `INSERT INTO message (
            tenant_id, conversation_id, group_id, channel, channel_msg_id,
            sender_role, sender_channel_user_id, msg_type, content, sent_at, received_at
          ) VALUES (?, ?, ?, ?, ?, 'BOT', 'bot', 'text', ?, NOW(3), NOW(3))`,
          [
            group.tenant_id,
            group.conversation_id,
            group.id,
            channel,
            fallbackChannelMsgId,
            this.fallbackText,
          ],
        );

        this.logger.log(
          `[Watchdog] 已向会话 [convId=${convId}] 写入降级友好话术: "${this.fallbackText}"`,
        );

        // ②-1 真正发到群里（@ 本组客户），并把这一轮记为降级发出；发送失败只记日志，不影响释放会话锁
        await this.sendFallback(group, convRows?.[0], turnId);

        // ③ 清理在途键与会话排他锁，并唤醒缓冲池排队消息
        await this.cleanupRedisInflightAndLock(convId);

        if (this.sealerService) {
          try {
            await this.sealerService.onTurnDone(convId);
          } catch (sealerErr: any) {
            this.logger.error(
              `[Watchdog] 触发 sealerService.onTurnDone 唤醒滞留消息失败: ${sealerErr.message}`,
              sealerErr.stack,
            );
          }
        }

        report.recovered++;
      } else {
        // 组已经在数据库处于终态（例如已被正常发出 SENT 或作废 VOIDED），属于 Redis 残留
        this.logger.debug(
          `[Watchdog] 组 #${groupId} 在 DB 中已处于终态 (${currentStatus})，清理残留 Redis 键`,
        );
        await this.cleanupRedisInflightAndLock(convId);
        report.clearedStale++;
      }
    } catch (err: any) {
      this.logger.error(
        `[Watchdog] 处理超时在途组 (convId=${convId}, groupId=${groupId}) 异常: ${err.message}`,
        err.stack,
      );
    }
  }

  /** 兜底话术发到群里并收尾这一轮（核心服务稍后回来的结果会因组已不在处理中而作废，不会重复回复） */
  private async sendFallback(
    group: RowDataPacket,
    conv: RowDataPacket | undefined,
    turnId?: string,
  ): Promise<void> {
    const pool = this.mysqlService.getPool();
    if (this.channelAdapter && conv?.channel_chat_id) {
      try {
        await this.channelAdapter.send({
          tenantId: Number(group.tenant_id),
          channel: conv.channel as ChannelType,
          channelChatId: conv.channel_chat_id,
          kind: 'REPLY',
          text: this.fallbackText,
          mentions: group.sender_channel_user_id ? [group.sender_channel_user_id] : [],
          conversationId: Number(group.conversation_id),
        });
      } catch (err: any) {
        this.logger.error(`[Watchdog] 兜底话术发送失败 (groupId=${group.id}): ${err.message}`);
      }
    }
    if (turnId) {
      try {
        await pool.query(
          `UPDATE turn SET status = 'DONE', reply_status = 'DEGRADED', reply_text = ?, finished_at = NOW(3)
            WHERE id = ? AND tenant_id = ? AND status <> 'DONE'`,
          [this.fallbackText, turnId, group.tenant_id],
        );
        // 组与轮关联起来：下一组接关时能看到这次兜底回复
        await pool.query('UPDATE msg_group SET turn_id = ? WHERE id = ? AND turn_id IS NULL', [turnId, group.id]);
      } catch (err: any) {
        this.logger.error(`[Watchdog] 更新轮 #${turnId} 失败: ${err.message}`);
      }
    }
  }

  /**
   * 清除指定会话的在途键与排他锁
   */
  private async cleanupRedisInflightAndLock(convId: number | string): Promise<void> {
    const redis = this.redisService.getClient();
    await redis.del(REDIS_KEYS.inflight(convId));
    await redis.del(REDIS_KEYS.convLock(convId));
  }
}
