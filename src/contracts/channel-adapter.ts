/**
 * @file channel-adapter.ts
 * @description 智能体全能平台统一渠道发送抽象契约
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §5.2、§6.2、§11.1
 */

import type { ChannelType } from './enums';
import type { OutboundMessage } from './message';

/**
 * 渠道适配器：负责将核心应用生成的统一出站消息 OutboundMessage 投递至具体的外部渠道
 */
export interface ChannelAdapter {
  readonly channel?: ChannelType;
  /**
   * 发送出站消息到渠道
   */
  send(msg: OutboundMessage): Promise<{ channelMsgId?: string } | void>;
}

/**
 * 渠道适配器依赖注入 Token
 */
export const CHANNEL_ADAPTER = Symbol('CHANNEL_ADAPTER');
