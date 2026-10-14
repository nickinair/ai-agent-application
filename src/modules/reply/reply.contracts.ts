/**
 * 与核心服务（crm-ai-agent，理解与回复）的队列契约，原件在 crm-ai-agent/src/runtime/turn-queue/contracts.ts，两边需同步修改。
 *   agent.queue.turn         运行时封组后投递（sealer.service）→ 核心服务
 *   agent.queue.post         核心服务投递回复 → 本模块（末检、话筒校验、发出）
 *   agent.queue.turn-result  本模块回报发送结果 → 核心服务落库
 */
import type { OutboundMessage } from '../../contracts';

export const REPLY_QUEUES = {
  turn: 'agent.queue.turn',
  post: 'agent.queue.post',
  result: 'agent.queue.turn-result',
} as const;

export type HandoffTrigger = 'SENSITIVE' | 'INTENT' | 'FRUSTRATION' | 'BLIND_SPOT';

export interface PostJob {
  version: 1;
  traceId: string;
  tenantId: number;
  conversationId: number;
  turnId: number;
  groupId: number;
  mergeCount: number;
  /** 本组客户在渠道内的 ID：末检只看这个人的新消息 */
  senderUserId: string;
  kind: 'REPLY' | 'CLOSE' | 'SILENT';
  /** 群内回复：channelChatId、mentions（本组客户；转人工时含客服）已填好 */
  reply?: OutboundMessage;
  handoff?: {
    trigger: HandoffTrigger;
    evidence: string;
    staff: { id: number; name: string; wecomUserId: string } | null;
    privateMessage?: OutboundMessage;
    /** true：话筒锁给人工、不自动交回；false：人工超时未回复自动交回机器人 */
    lockMic: boolean;
  };
  confidence: number;
  lowConfidence: boolean;
  degraded: boolean;
  sealedAt: number | null;
  generatedAt: number;
  timings: Record<string, number>;
  trace: { relation: string | null; intents: Array<{ main: string; sub: string | null; span: string }>; scene: string; action: string };
}

export type TurnResult = 'SENT' | 'VOIDED' | 'SEND_FAILED' | 'RECOMPUTE';

export interface TurnResultJob {
  turnId: number;
  groupId: number;
  mergeCount: number;
  result: TurnResult;
  replyMessageId?: number;
}
