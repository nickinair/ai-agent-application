/**
 * @file mq.ts
 * @description 消息队列拓扑契约与统一事件信封标准（EventEnvelope）
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §4、§16.4
 */

import { randomUUID } from 'node:crypto';
import type { InboundMessage, OutboundMessage } from './message';

/**
 * 平台核心事件 Topic 交换机名称
 * 
 * 业务背景：
 * - 服务间通过 MQ 解耦，不上注册中心；
 * - 采用 Topic Exchange，基于 routing key 路由分发；
 * - 保证队列持久化、消息持久化与手动 ACK 应答机制。
 */
export const MQ_EXCHANGE = 'agent.events';

/**
 * MQ 事件路由键常量定义
 */
export const ROUTING_KEYS = {
  /** 渠道入站事件（Gateway -> Core） */
  inboundMessage: 'inbound.message',

  /** 渠道出站事件（Core -> Gateway） */
  outboundMessage: 'outbound.message',
} as const;

/**
 * MQ 队列名称常量定义
 */
export const QUEUES = {
  /** 核心服务消费队列：接收规范化后的渠道入站消息 */
  coreInbound: 'core.inbound',

  /** 网关服务消费队列：接收待向渠道发出的回复消息 */
  gatewayOutbound: 'gateway.outbound',
} as const;

/**
 * 事件载荷映射字典
 */
export interface EventPayloads {
  'inbound.message': InboundMessage;
  'outbound.message': OutboundMessage;
}

/**
 * 合法事件类型键名
 */
export type EventType = keyof EventPayloads;

/**
 * 异步事件的统一传输信封契约（§16.4）
 * 
 * 业务流转：
 * - 所有在 RabbitMQ 中流转的消息统一使用此信封包装；
 * - traceId 全程贯穿透传（网关 -> 核心 -> 回复出站），保障链路日志可染色追溯。
 */
export interface EventEnvelope<T extends EventType = EventType> {
  /**
   * 事件实例唯一全局 ID（UUIDv4）
   * 业务边界：用于 MQ 消费端的全局幂等去重防重复消费
   */
  eventId: string;

  /**
   * 事件类别标识
   */
  type: T;

  /**
   * 信封契约协议版本号（当前固定为 1）
   */
  version: 1;

  /**
   * 全链路分布式追踪 ID
   */
  traceId: string;

  /**
   * 业务所属企业租户 ID（业务范围: > 0）
   */
  tenantId: number;

  /**
   * 事件生成时间戳（毫秒）
   */
  occurredAt: number;

  /**
   * 实际业务事件载荷
   */
  payload: EventPayloads[T];
}

/**
 * 便捷构造标准事件信封的工厂函数
 * 
 * @param type 事件类型
 * @param payload 事件载荷对象
 * @param opts 包含 tenantId 以及可选的 traceId（未提供时自动生成 UUIDv4）
 */
export function makeEnvelope<T extends EventType>(
  type: T,
  payload: EventPayloads[T],
  opts: { traceId?: string; tenantId: number },
): EventEnvelope<T> {
  return {
    eventId: randomUUID(),
    type,
    version: 1,
    traceId: opts.traceId ?? randomUUID(),
    tenantId: opts.tenantId,
    occurredAt: Date.now(),
    payload,
  };
}
