/**
 * @file final-check.spec.ts
 * @description Task 4.6: 阶段四综合单元测试验证集 (附录 C 用例 S4, S5, S6, S7 终验与作废审计)
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §5.8.1、§14 监控与运维、附录 C (S4, S5, S6, S7)
 */

import { FinalCheckService } from '../../src/modules/pipeline/final-check.service';
import { BufferService } from '../../src/modules/pipeline/buffer.service';
import { StateTransitionService } from '../../src/modules/pipeline/state-transition.service';
import { MicrophoneService } from '../../src/modules/pipeline/microphone.service';
import { MysqlService } from '../../src/database/mysql.service';
import { MetricsService } from '../../src/infra/metrics.service';
import type {
  TurnContext,
  ChannelAdapter,
  OutboundMessage,
  MessageRef,
} from '../../src/contracts';

describe('Task 4.6: 阶段四综合单元测试验证集 (S4, S5, S6, S7 终验与作废审计)', () => {
  let finalCheckService: FinalCheckService;
  let metricsService: MetricsService;

  // 依赖的 Mock 对象
  let mockBufferService: any;
  let mockStateTransitionService: any;
  let mockMicrophoneService: any;
  let mockMysqlService: any;
  let mockChannelAdapter: ChannelAdapter;

  // 模拟数据库与内存状态
  let dbQueries: Array<{ sql: string; params: any[] }>;
  let stateTransitions: Array<{
    entityType: string;
    entityId: number;
    from: string;
    to: string;
    reason?: string;
  }>;
  let outboundSentMessages: OutboundMessage[];
  let bufferPool: MessageRef[];

  const tenantId = 101;
  const convId = 8801;
  const senderId = 'wm_cust_li';

  beforeEach(() => {
    dbQueries = [];
    stateTransitions = [];
    outboundSentMessages = [];
    bufferPool = [];

    metricsService = new MetricsService();

    // 1. Mock BufferService
    mockBufferService = {
      peekSince: jest.fn().mockImplementation(async (cId: number, sinceMs: number, sId?: string) => {
        return bufferPool.filter((m) => m.sentAt > sinceMs);
      }),
      takeInto: jest.fn().mockImplementation(
        async (cId: number, gId: number, msgs: MessageRef[], sId?: string) => {
          const msgIds = new Set(msgs.map((m) => m.channelMsgId));
          bufferPool = bufferPool.filter((m) => !msgIds.has(m.channelMsgId));
          return msgs.length;
        },
      ),
    };

    // 2. Mock StateTransitionService
    mockStateTransitionService = {
      transition: jest.fn().mockImplementation(
        async (entityType: string, entityId: number, from: string, to: string, payload?: any) => {
          stateTransitions.push({
            entityType,
            entityId,
            from,
            to,
            reason: payload?.reason,
          });
          return true;
        },
      ),
    };

    // 3. Mock MicrophoneService
    mockMicrophoneService = {
      getMicStatus: jest.fn().mockResolvedValue({
        owner: 'BOT',
        staffId: null,
        epoch: 1,
      }),
    };

    // 4. Mock MysqlService
    mockMysqlService = {
      getPool: () => ({
        query: async (sql: string, params: any[]) => {
          dbQueries.push({ sql, params });
          return [[]];
        },
      }),
    };

    // 5. Mock ChannelAdapter
    mockChannelAdapter = {
      send: jest.fn().mockImplementation(async (msg: OutboundMessage) => {
        outboundSentMessages.push(msg);
      }),
    };

    // 实例化 FinalCheckService
    finalCheckService = new FinalCheckService(
      mockBufferService,
      mockStateTransitionService,
      mockMicrophoneService,
      mockChannelAdapter,
      mockMysqlService,
      metricsService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('1. 用例 S4: 组 A 生成中客户发“不对问的是延保” (首次纠正合并重算)', () => {
    it('末检识别 CORRECT，合并新消息入组 A，组状态退回 UNDERSTANDING，mergeCount: 0 -> 1，重算后安全发出', async () => {
      const sealedTime = Date.now() - 3000;

      // 组 A 上下文（生成中）
      const ctx: TurnContext = {
        turnId: 4601,
        tenantId,
        conversationId: convId,
        groupId: 9101,
        traceId: 'tr_s4_test',
        groupText: '我想了解一下汽车保养价格',
        groupMessages: [
          {
            messageId: 46011,
            channelMsgId: 'm_s4_01',
            senderRole: 'CUSTOMER',
            text: '我想了解一下汽车保养价格',
            sentAt: sealedTime - 1000,
          },
        ],
        sealedAt: sealedTime,
        mergeCount: 0,
        reply: {
          text: '基础保养小保价格通常在 300-500 元之间',
          confidence: 0.95,
        },
      } as any;

      // 客户在生成期间追发纠正消息入缓冲池
      const correctionMsg: MessageRef = {
        messageId: 46012,
        channelMsgId: 'm_s4_02',
        senderRole: 'CUSTOMER',
        text: '不对，我问的是延保不是基础保养',
        sentAt: sealedTime + 500,
      };
      bufferPool.push(correctionMsg);

      // 执行末检
      const checkRes = await finalCheckService.finalCheck(ctx);

      // 断言 1: 判定接关动作为 RECOMPUTE，判定关系为 CORRECT
      expect(checkRes.action).toBe('RECOMPUTE');
      expect(checkRes.verdict).toBe('CORRECT');
      expect(ctx.finalCheck?.recomputed).toBe(true);

      // 断言 2: 新消息从缓冲池出队并入组 A
      expect(mockBufferService.takeInto).toHaveBeenCalledWith(
        convId,
        ctx.groupId,
        expect.arrayContaining([expect.objectContaining({ channelMsgId: 'm_s4_02' })]),
        undefined,
      );
      expect(bufferPool.length).toBe(0);

      // 断言 3: 组文本与消息列表更新追加，mergeCount 递增为 1
      expect(ctx.groupText).toContain('我想了解一下汽车保养价格');
      expect(ctx.groupText).toContain('不对，我问的是延保不是基础保养');
      expect(ctx.groupMessages?.length).toBe(2);
      expect(ctx.mergeCount).toBe(1);

      // 断言 4: 组状态机流转回 UNDERSTANDING 重新理解计算
      const transitionToUnderstanding = stateTransitions.find(
        (t) =>
          t.entityType === 'GROUP' &&
          t.entityId === ctx.groupId &&
          t.from === 'FINAL_CHECKING' &&
          t.to === 'UNDERSTANDING',
      );
      expect(transitionToUnderstanding).toBeDefined();

      // 断言 5: 之前已生成草稿，记录 RECOMPUTE_ABANDONED 指标
      expect(
        metricsService.turnVoidedTotal.get({
          reason: 'RECOMPUTE_ABANDONED',
          tenant_id: String(tenantId),
        }),
      ).toBe(1);

      // 模拟重算后生成了全新的准确回复，并调用 safeSend 最终下发
      ctx.reply = {
        text: '关于整车延保方案，我们提供 1年/3万公里 与 2年/6万公里 两种服务套餐',
        confidence: 0.98,
      } as any;
      const sendSuccess = await finalCheckService.safeSend(ctx);

      expect(sendSuccess).toBe(true);
      expect(mockChannelAdapter.send).toHaveBeenCalledTimes(1);
      expect(outboundSentMessages[0].text).toBe(ctx.reply?.text);

      // 验证 DB 最终记录 reply_status = 'SENT'
      const updateSentQuery = dbQueries.find(
        (q) =>
          q.sql.includes('UPDATE turn SET reply_status = \'SENT\'') &&
          q.params.includes(ctx.turnId),
      );
      expect(updateSentQuery).toBeDefined();
    });
  });

  describe('2. 用例 S5: 重算后客户又发纠正 (单次熔断禁止死循环)', () => {
    it('当 mergeCount >= 1 时检测到纠正：熔断禁止再次合并，原回复照常发出，新消息完整保留在缓冲池', async () => {
      const sealedTime = Date.now() - 2000;

      // 组 A 上下文（已经重算过 1 次，mergeCount = 1）
      const ctx: TurnContext = {
        turnId: 4602,
        tenantId,
        conversationId: convId,
        groupId: 9102,
        traceId: 'tr_s5_test',
        groupText: '我想了解一下汽车保养价格\n不对，我问的是延保',
        groupMessages: [
          {
            messageId: 46021,
            channelMsgId: 'm_s5_01',
            senderRole: 'CUSTOMER',
            text: '我想了解一下汽车保养价格',
            sentAt: sealedTime - 2000,
          },
          {
            messageId: 46022,
            channelMsgId: 'm_s5_02',
            senderRole: 'CUSTOMER',
            text: '不对，我问的是延保',
            sentAt: sealedTime - 1000,
          },
        ],
        sealedAt: sealedTime,
        mergeCount: 1, // 已达单次合并上限
        reply: {
          text: '为您提供延保方案详情...',
          confidence: 0.95,
        },
      } as any;

      // 客户在二次生成期间又发了一句纠正
      const secondCorrection: MessageRef = {
        messageId: 46023,
        channelMsgId: 'm_s5_03',
        senderRole: 'CUSTOMER',
        text: '错啦，我想问的是发动机延保多少钱',
        sentAt: sealedTime + 500,
      };
      bufferPool.push(secondCorrection);

      // 执行末检
      const checkRes = await finalCheckService.finalCheck(ctx);

      // 断言 1: 返回 action = 'SEND'，禁止继续重算 (recomputed = false)
      expect(checkRes.action).toBe('SEND');
      expect(checkRes.verdict).toBe('CORRECT');
      expect(ctx.finalCheck?.recomputed).toBe(false);

      // 断言 2: takeInto 绝不被调用，新消息完整保留在缓冲池供下一组处理
      expect(mockBufferService.takeInto).not.toHaveBeenCalled();
      expect(bufferPool.length).toBe(1);
      expect(bufferPool[0].channelMsgId).toBe('m_s5_03');

      // 断言 3: mergeCount 保持为 1，不发生无限循环
      expect(ctx.mergeCount).toBe(1);

      // 断言 4: 原回复照常安全下发
      const sent = await finalCheckService.safeSend(ctx);
      expect(sent).toBe(true);
      expect(mockChannelAdapter.send).toHaveBeenCalledTimes(1);
      expect(outboundSentMessages[0].text).toBe('为您提供延保方案详情...');

      // 验证未产生 RECOMPUTE_ABANDONED 指标
      expect(
        metricsService.turnVoidedTotal.get({
          reason: 'RECOMPUTE_ABANDONED',
          tenant_id: String(tenantId),
        }),
      ).toBe(0);
    });
  });

  describe('3. 用例 S6: 客户发“另外保养多少钱” (换题新消息保留在缓冲池)', () => {
    it('末检识别 NEW_TOPIC：组 A 照常下发，新消息不出队且留在缓冲池独立成组 B', async () => {
      const sealedTime = Date.now() - 2500;

      // 组 A 上下文（延保咨询已生成完毕）
      const ctx: TurnContext = {
        turnId: 4603,
        tenantId,
        conversationId: convId,
        groupId: 9103,
        traceId: 'tr_s6_test',
        groupText: '延保包含哪些核心零部件？',
        sealedAt: sealedTime,
        mergeCount: 0,
        reply: {
          text: '延保涵盖发动机、变速箱及核心电气控制系统。',
          confidence: 0.95,
        },
      } as any;

      // 客户在发送前发了新话题消息
      const newTopicMsg: MessageRef = {
        messageId: 46031,
        channelMsgId: 'm_s6_01',
        senderRole: 'CUSTOMER',
        text: '另外换机油大概多少钱？',
        sentAt: sealedTime + 600,
      };
      bufferPool.push(newTopicMsg);

      // 执行末检
      const checkRes = await finalCheckService.finalCheck(ctx);

      // 断言 1: 判定为 NEW_TOPIC 并直接放行 SEND
      expect(checkRes.action).toBe('SEND');
      expect(checkRes.verdict).toBe('NEW_TOPIC');
      expect(ctx.finalCheck?.verdict).toBe('NEW_TOPIC');

      // 断言 2: 新话题消息不出队，原汁原味保留在缓冲池中供组 B 独立成组
      expect(mockBufferService.takeInto).not.toHaveBeenCalled();
      expect(bufferPool.length).toBe(1);
      expect(bufferPool[0].text).toBe('另外换机油大概多少钱？');

      // 断言 3: 组 A 执行 safeSend 顺利下发给渠道
      const sendRes = await finalCheckService.safeSend(ctx);
      expect(sendRes).toBe(true);
      expect(mockChannelAdapter.send).toHaveBeenCalledTimes(1);
      expect(outboundSentMessages[0].text).toBe('延保涵盖发动机、变速箱及核心电气控制系统。');

      // 断言 4: 组 A 状态跃迁至 SENT
      const sentTransition = stateTransitions.find(
        (t) => t.entityType === 'GROUP' && t.entityId === ctx.groupId && t.to === 'SENT',
      );
      expect(sentTransition).toBeDefined();
    });
  });

  describe('4. 用例 S7 终验: 渠道下发前一刻话筒被夺 (毫秒级防并发拦截)', () => {
    it('在执行网络下发前最后一刻，客服插话抢走话筒：safeSend 掐断下发，转 VOIDED 并记录审计与指标', async () => {
      const ctx: TurnContext = {
        turnId: 4604,
        tenantId,
        conversationId: convId,
        groupId: 9104,
        traceId: 'tr_s7_final_check',
        reply: {
          text: '先生您好，建议您到店免费检测蓄电池寿命。',
        },
      } as any;

      // 模拟最后一刻坐席插话，话筒所有者变为 HUMAN
      mockMicrophoneService.getMicStatus.mockResolvedValueOnce({
        owner: 'HUMAN',
        staffId: 'staff_agent_chen',
        epoch: 3,
      });

      // 执行安全下发
      const sendResult = await finalCheckService.safeSend(ctx);

      // 断言 1: safeSend 返回 false，下发被掐断，ChannelAdapter.send 绝不被调用
      expect(sendResult).toBe(false);
      expect(mockChannelAdapter.send).not.toHaveBeenCalled();

      // 断言 2: 组 A 状态机流转为 VOIDED
      const voidedTransition = stateTransitions.find(
        (t) =>
          t.entityType === 'GROUP' &&
          t.entityId === ctx.groupId &&
          t.from === 'FINAL_CHECKING' &&
          t.to === 'VOIDED',
      );
      expect(voidedTransition).toBeDefined();
      expect(voidedTransition?.reason).toBe('MIC_SEIZED');

      // 断言 3: turn 表落库作废审计，保存 void_reason 与未发出的草稿文本
      const voidDbQuery = dbQueries.find(
        (q) =>
          q.sql.includes('UPDATE turn SET reply_status = \'VOIDED\'') &&
          q.sql.includes('void_reason = ?'),
      );
      expect(voidDbQuery).toBeDefined();
      expect(voidDbQuery?.params).toContain('MIC_SEIZED');
      expect(voidDbQuery?.params).toContain('先生您好，建议您到店免费检测蓄电池寿命。');
      expect(voidDbQuery?.params).toContain(ctx.turnId);

      // 断言 4: Prometheus 指标 agent_turn_voided_total 累加
      expect(
        metricsService.turnVoidedTotal.get({
          reason: 'MIC_SEIZED',
          tenant_id: String(tenantId),
        }),
      ).toBe(1);
    });
  });

  describe('5. 全量作废场景审计与 Prometheus 监控大盘文本输出', () => {
    it('多种作废场景共存时，准确统计各维度并输出符合 Prometheus 格式的 Metrics 文本', async () => {
      // 模拟多轮作废与业务场景
      metricsService.recordTurnVoided('MIC_SEIZED', tenantId, 2);
      metricsService.recordTurnVoided('RECOMPUTE_ABANDONED', tenantId, 1);
      metricsService.recordTurnVoided('RULE_BLOCKED', tenantId, 1);
      metricsService.recordTurnVoided('MIC_SEIZED', 999, 1);

      // 验证各维度独立准确
      expect(metricsService.turnVoidedTotal.get({ reason: 'MIC_SEIZED', tenant_id: String(tenantId) })).toBe(2);
      expect(metricsService.turnVoidedTotal.get({ reason: 'RECOMPUTE_ABANDONED', tenant_id: String(tenantId) })).toBe(1);
      expect(metricsService.turnVoidedTotal.get({ reason: 'RULE_BLOCKED', tenant_id: String(tenantId) })).toBe(1);
      expect(metricsService.turnVoidedTotal.get({ reason: 'MIC_SEIZED', tenant_id: '999' })).toBe(1);

      // 验证输出 Prometheus 纯文本标准
      const metricsText = metricsService.getMetricsAsText();
      expect(metricsText).toContain('# HELP agent_turn_voided_total');
      expect(metricsText).toContain('# TYPE agent_turn_voided_total counter');
      expect(metricsText).toContain(`agent_turn_voided_total{reason="MIC_SEIZED",tenant_id="${tenantId}"} 2`);
      expect(metricsText).toContain(`agent_turn_voided_total{reason="RECOMPUTE_ABANDONED",tenant_id="${tenantId}"} 1`);
      expect(metricsText).toContain(`agent_turn_voided_total{reason="RULE_BLOCKED",tenant_id="${tenantId}"} 1`);
      expect(metricsText).toContain('agent_turn_voided_total{reason="MIC_SEIZED",tenant_id="999"} 1');
    });
  });
});
