/**
 * @file buffer.service.ts
 * @description 客户消息时间×发送人聚合缓冲池服务（基于 Redis 原子操作）
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §5.3、§7.1、§7.3、§7.4
 */

import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../infra/redis/redis.service';
import { REDIS_KEYS } from '../../infra/redis/redis.keys';

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

  constructor(private readonly redisService: RedisService) {}

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
}
