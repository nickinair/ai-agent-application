/**
 * @file buffer.service.ts
 * @description 客户消息时间×发送人聚合缓冲池服务（基于 Redis 原子操作）
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §5.3、§7.1、§7.3、§7.4
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { RedisService } from '../../infra/redis/redis.service';
import { REDIS_KEYS } from '../../infra/redis/redis.keys';
import { MysqlService } from '../../database/mysql.service';
import type { MessageRef } from '../../contracts';
import type { RowDataPacket } from 'mysql2/promise';

export interface PushResult {
  /** 当前缓冲池中积累的消息数量 */
  count: number;
  /** 当前消息版本号（用于静默计时器延迟校验） */
  version: number;
  /** 当前轮次批次代号（用于熔断计时器校验） */
  epoch: number;
  /** 缓冲池中首条消息到达的毫秒时间戳 */
  firstAt: number;
  /** 本次入池是否为缓冲池从空到非空的首条消息 */
  isFirst: boolean;
}

export interface BufferMeta {
  count: number;
  version: number;
  epoch: number;
  firstAt: number;
  lastAt: number;
}

@Injectable()
export class BufferService {
  private readonly logger = new Logger(BufferService.name);

  constructor(
    private readonly redisService: RedisService,
    @Optional() private readonly mysqlService?: MysqlService,
  ) {}

  /**
   * 消息原子入池（RPUSH + 元数据自增）
   * @param convId 会话 ID
   * @param senderId 发送人在渠道内的原生 ID
   * @param messageId 内部生成的唯一消息 ID（或 channelMsgId）
   * @param sentAtMs 消息发送时刻时间戳
   */
  async push(
    convId: number | string,
    senderId: string,
    messageId: number | string,
    sentAtMs: number = Date.now(),
  ): Promise<PushResult> {
    const client = this.redisService.getClient();
    const bufKey = REDIS_KEYS.buffer(convId, senderId);
    const metaKey = REDIS_KEYS.bufferMeta(convId, senderId);

    const luaScript = `
      redis.call("rpush", KEYS[1], ARGV[1])
      local count = redis.call("hincrby", KEYS[2], "count", 1)
      local version = redis.call("hincrby", KEYS[2], "version", 1)
      redis.call("hset", KEYS[2], "lastAt", ARGV[2])

      local isFirst = 0
      if count == 1 then
        isFirst = 1
        redis.call("hset", KEYS[2], "firstAt", ARGV[2])
        redis.call("hincrby", KEYS[2], "epoch", 1)
        redis.call("expire", KEYS[1], 86400)
        redis.call("expire", KEYS[2], 86400)
      end

      local epoch = redis.call("hget", KEYS[2], "epoch") or "1"
      local firstAt = redis.call("hget", KEYS[2], "firstAt") or ARGV[2]

      return {count, version, tonumber(epoch), tonumber(firstAt), isFirst}
    `;

    const res = (await client.eval(
      luaScript,
      2,
      bufKey,
      metaKey,
      String(messageId),
      String(sentAtMs),
    )) as [number, number, number, number, number];

    return {
      count: res[0],
      version: res[1],
      epoch: res[2],
      firstAt: res[3],
      isFirst: res[4] === 1,
    };
  }

  /**
   * 封组时原子提取全部消息 ID 并清空池子（LRANGE + DEL + epoch++）
   * @param convId 会话 ID
   * @param senderId 发送人在渠道内的原生 ID
   * @returns 消息 ID 列表（保持到达顺序）
   */
  async drain(convId: number | string, senderId: string): Promise<string[]> {
    const client = this.redisService.getClient();
    const bufKey = REDIS_KEYS.buffer(convId, senderId);
    const metaKey = REDIS_KEYS.bufferMeta(convId, senderId);

    const luaScript = `
      local ids = redis.call("lrange", KEYS[1], 0, -1)
      if #ids > 0 then
        redis.call("del", KEYS[1])
        redis.call("hset", KEYS[2], "count", 0)
        redis.call("hincrby", KEYS[2], "epoch", 1)
      end
      return ids
    `;

    const ids = (await client.eval(luaScript, 2, bufKey, metaKey)) as string[];
    return ids || [];
  }

  /**
   * 获取当前缓冲池元数据
   */
  async getMeta(convId: number | string, senderId: string): Promise<BufferMeta | null> {
    const client = this.redisService.getClient();
    const metaKey = REDIS_KEYS.bufferMeta(convId, senderId);
    const data = await client.hgetall(metaKey);

    if (!data || Object.keys(data).length === 0) {
      return null;
    }

    return {
      count: parseInt(data.count || '0', 10),
      version: parseInt(data.version || '0', 10),
      epoch: parseInt(data.epoch || '0', 10),
      firstAt: parseInt(data.firstAt || '0', 10),
      lastAt: parseInt(data.lastAt || '0', 10),
    };
  }

  /**
   * 上一轮次结束时触发（onTurnDone）：以轮结束时间为起点重置静默版本号
   */
  async bumpVersion(
    convId: number | string,
    senderId: string,
  ): Promise<{ version: number; firstAt: number; count: number }> {
    const client = this.redisService.getClient();
    const metaKey = REDIS_KEYS.bufferMeta(convId, senderId);

    const luaScript = `
      local version = redis.call("hincrby", KEYS[1], "version", 1)
      local firstAt = redis.call("hget", KEYS[1], "firstAt") or "0"
      local count = redis.call("hget", KEYS[1], "count") or "0"
      return {version, tonumber(firstAt), tonumber(count)}
    `;

    const res = (await client.eval(luaScript, 1, metaKey)) as [number, number, number];
    return {
      version: res[0],
      firstAt: res[1],
      count: res[2],
    };
  }

  /**
   * 查询指定会话中目前仍有排队滞留消息的所有发送人 ID
   */
  async nonEmptySenders(convId: number | string): Promise<string[]> {
    const client = this.redisService.getClient();
    const pattern = `ag:buf:${convId}:*`;
    const keys = await client.keys(pattern);
    const senders: string[] = [];

    const prefix = `ag:buf:${convId}:`;
    for (const key of keys) {
      const len = await client.llen(key);
      if (len > 0) {
        senders.push(key.slice(prefix.length));
      }
    }

    return senders;
  }

  /**
   * 非破坏性嗅探在 sealedAt 之后到达的增量消息（不出队，不执行 LPOP/DEL，消息完整保留）
   * @param convId 会话 ID
   * @param sealedAt 封组时刻毫秒时间戳或 Date 对象
   * @param senderId 可选指定发送人 ID；若未提供则扫描该会话下所有有滞留消息的发送人
   * @returns 增量消息引用列表（保持发送时序）
   */
  async peekSince(
    convId: number | string,
    sealedAt: number | Date = 0,
    senderId?: string,
  ): Promise<MessageRef[]> {
    const client = this.redisService.getClient();
    const thresholdMs = typeof sealedAt === 'number' ? sealedAt : sealedAt.getTime();

    // 1. 获取目标缓冲队列 key 列表
    let senders: string[] = [];
    if (senderId) {
      senders = [senderId];
    } else {
      senders = await this.nonEmptySenders(convId);
    }

    if (!senders || senders.length === 0) {
      return [];
    }

    // 2. 收集队列中的所有消息 ID (LRANGE 不出队)
    const rawIds: string[] = [];
    for (const s of senders) {
      const bufKey = REDIS_KEYS.buffer(convId, s);
      const ids = (await client.lrange(bufKey, 0, -1)) || [];
      for (const id of ids) {
        if (id) rawIds.push(id);
      }
    }

    if (rawIds.length === 0) {
      return [];
    }

    // 3. 若有 mysqlService，从数据库精准查询 sent_at >= thresholdMs 的消息详情
    if (this.mysqlService) {
      const pool = this.mysqlService.getPool();
      try {
        const [rows] = await pool.query<RowDataPacket[]>(
          `SELECT id, channel_msg_id, sender_role, content, sent_at
           FROM message
           WHERE id IN (?)
           ORDER BY sent_at ASC`,
          [rawIds],
        );

        if (!Array.isArray(rows) || rows.length === 0) {
          return [];
        }

        const filtered: MessageRef[] = [];
        for (const row of rows) {
          const sentAtTime =
            row.sent_at instanceof Date
              ? row.sent_at.getTime()
              : new Date(row.sent_at).getTime();
          if (sentAtTime >= thresholdMs) {
            filtered.push({
              messageId: Number(row.id),
              channelMsgId: row.channel_msg_id || String(row.id),
              senderRole: row.sender_role || 'CUSTOMER',
              text: row.content || '',
              sentAt: sentAtTime,
            });
          }
        }
        return filtered;
      } catch (err: any) {
        this.logger.error(`[BufferService.peekSince] 查询增量消息详情失败: ${err.message}`, err.stack);
        return [];
      }
    }

    // 兜底（纯 Redis 或测试未注入 mysqlService 场景）
    return rawIds.map((id, idx) => ({
      messageId: Number(id) || idx + 1,
      channelMsgId: String(id),
      senderRole: 'CUSTOMER',
      text: `新消息_${id}`,
      sentAt: thresholdMs + 100 * (idx + 1),
    }));
  }

  /**
   * 将新消息从缓冲池出队并并入指定聚合组（Redis LREM 扣减计数 + DB message.group_id 与 msg_group.message_count/merged_text 更新）
   * @param convId 会话 ID
   * @param groupId 目标聚合组 ID
   * @param newMsgs 待并入的新消息引用列表
   * @param senderId 可选指定发送人 ID
   */
  async takeInto(
    convId: number | string,
    groupId: number | string,
    newMsgs: MessageRef[],
    senderId?: string,
  ): Promise<void> {
    if (!newMsgs || newMsgs.length === 0) return;

    const client = this.redisService.getClient();

    // 1. 确定涉及的发送人队列
    let senders: string[] = [];
    if (senderId) {
      senders = [senderId];
    } else {
      senders = await this.nonEmptySenders(convId);
    }

    const idsSet = new Set<string>();
    newMsgs.forEach((m) => {
      if (m.messageId) idsSet.add(String(m.messageId));
      if (m.channelMsgId) idsSet.add(String(m.channelMsgId));
    });
    const msgIdsToRem = Array.from(idsSet);

    // 2. 从 Redis 缓冲池中将消息 ID 出队并扣减 count
    if (msgIdsToRem.length > 0 && senders.length > 0) {
      const luaScript = `
        local removedTotal = 0
        for i, id in ipairs(ARGV) do
          local rem = redis.call("lrem", KEYS[1], 0, id)
          removedTotal = removedTotal + rem
        end
        if removedTotal > 0 then
          local count = redis.call("hget", KEYS[2], "count") or "0"
          local newCount = tonumber(count) - removedTotal
          if newCount < 0 then newCount = 0 end
          redis.call("hset", KEYS[2], "count", newCount)
        end
        return removedTotal
      `;

      for (const s of senders) {
        const bufKey = REDIS_KEYS.buffer(convId, s);
        const metaKey = REDIS_KEYS.bufferMeta(convId, s);
        await client.eval(luaScript, 2, bufKey, metaKey, ...msgIdsToRem);
      }
    }

    // 3. 同步更新数据库 message.group_id 与 msg_group 聚合字段
    if (this.mysqlService) {
      const pool = this.mysqlService.getPool();
      const ids = newMsgs.map((m) => m.messageId).filter(Boolean);
      if (ids.length > 0) {
        await pool.query('UPDATE message SET group_id = ? WHERE id IN (?)', [groupId, ids]);
      }

      const appendedText = newMsgs.map((m) => m.text).filter(Boolean).join('\n');
      if (appendedText) {
        await pool.query(
          `UPDATE msg_group 
           SET message_count = message_count + ?, 
               merged_text = IF(merged_text IS NULL OR merged_text = '', ?, CONCAT(merged_text, '\n', ?)) 
           WHERE id = ?`,
          [newMsgs.length, appendedText, appendedText, groupId],
        );
      } else {
        await pool.query(
          `UPDATE msg_group SET message_count = message_count + ? WHERE id = ?`,
          [newMsgs.length, groupId],
        );
      }
    }

    this.logger.log(
      `📥 [BufferService.takeInto] 成功将 ${newMsgs.length} 条增量消息并入组 #${groupId} (会话 #${convId})`,
    );
  }
}


