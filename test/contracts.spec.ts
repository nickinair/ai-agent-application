/**
 * @file contracts.spec.ts
 * @description 智能体全能平台核心协议包与 Zod 校验契约单元测试
 */

import {
  InboundMessage,
  OutboundMessage,
  TurnContext,
  makeEnvelope,
  MQ_EXCHANGE,
  ROUTING_KEYS,
  QUEUES,
  IntentSpanSchema,
  UnderstandOutputSchema,
  OUTBOUND_MESSAGE_KIND,
  CHANNEL_TYPE,
  MEMBER_ROLE,
  MESSAGE_TYPE,
  MIC_HOLDER,
  TURN_RELATION,
  MAIN_INTENT,
  ACTION_TYPE,
  ANSWER_SOURCE,
  HANDOFF_TYPE,
  CONVERSATION_STATUS,
  TURN_STATUS,
  GROUP_STATUS,
  EMOTION_TYPE,
} from '../src/contracts';

describe('智能体全能平台统一协议契约包测试套件 (contracts)', () => {
  describe('1. 消息契约 (InboundMessage & OutboundMessage)', () => {
    it('能够成功构造合法的 InboundMessage 入站消息', () => {
      const inbound: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'wr_customer_group_001',
        channelMsgId: 'msg_channel_unique_123',
        chatName: '张三-13800000000-问界M5-未购',
        sender: {
          role: 'CUSTOMER',
          channelUserId: 'wm_customer_zhangsan',
          name: '张三',
        },
        mentions: [],
        type: 'text',
        text: '请问整车延保保哪些部件？多少钱？',
        sentAt: 1718000000000,
      };

      expect(inbound.tenantId).toBe(1);
      expect(inbound.channel).toBe('wecom_group');
      expect(inbound.sender.role).toBe('CUSTOMER');
      expect(inbound.channelMsgId).toBe('msg_channel_unique_123');
    });

    it('能够成功构造合法的 OutboundMessage 出站消息与私信交接包', () => {
      const replyOutbound: OutboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'wr_customer_group_001',
        kind: 'REPLY',
        text: '您好，整车延保包含发动机、变速箱及核心电气系统的延长保修服务。',
        mentions: ['wm_customer_zhangsan'],
        conversationId: 100,
        turnId: 1,
      };

      expect(replyOutbound.kind).toBe('REPLY');
      expect(replyOutbound.mentions).toContain('wm_customer_zhangsan');

      const handoffOutbound: OutboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'wr_customer_group_001',
        kind: 'HANDOFF_PACKAGE',
        text: '【交接包】客户张三咨询问界M5整车延保，已解答基础范围，因涉及专属优惠转人工客服跟进。',
        toUserId: 'staff_lisi_001',
        conversationId: 100,
        turnId: 1,
      };

      expect(handoffOutbound.kind).toBe('HANDOFF_PACKAGE');
      expect(handoffOutbound.toUserId).toBe('staff_lisi_001');
    });
  });

  describe('2. 核心流水线上下文 (TurnContext & SessionBackground)', () => {
    it('能够成功装配贯穿六道关的 TurnContext 主干模型', () => {
      const context: TurnContext = {
        traceId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        tenantId: 1,
        conversationId: 101,
        turnId: 1,
        groupId: 201,
        isFirstTurn: true,
        groupText: '在吗，问下延保，保哪些，多少钱',
        groupMessages: [
          {
            messageId: 1001,
            channelMsgId: 'msg_001',
            senderRole: 'CUSTOMER',
            text: '在吗，问下延保',
            sentAt: 1718000001000,
          },
          {
            messageId: 1002,
            channelMsgId: 'msg_002',
            senderRole: 'CUSTOMER',
            text: '保哪些，多少钱',
            sentAt: 1718000002000,
          },
        ],
        customer: {
          name: '王先生',
          phoneMasked: '138****8888',
          vehicle: '问界M5',
          product: '整车延保',
          bought: false,
        },
        background: {
          turns: [],
          profile: { vehicle: '问界M5' },
          emotionTrack: ['calm'],
          unresolved: [],
          counters: {
            correctionTotal: 0,
            correctionConsecutive: 0,
            lowConfConsecutive: 0,
            emotionBurst: 0,
          },
          factCard: {
            inQuestion: '整车延保',
            answered: [],
            pending: ['整车延保价格与范围'],
            customer: '王先生，问界M5潜客',
          },
        },
        rulePackVersion: 'v1.0.0',
        timings: {},
      };

      expect(context.isFirstTurn).toBe(true);
      expect(context.customer.bought).toBe(false);
      expect(context.groupMessages.length).toBe(2);
      expect(context.background.counters.correctionTotal).toBe(0);
    });
  });

  describe('3. MQ 拓扑与事件信封 (EventEnvelope)', () => {
    it('常量拓扑命名符合技术规范', () => {
      expect(MQ_EXCHANGE).toBe('agent.events');
      expect(ROUTING_KEYS.inboundMessage).toBe('inbound.message');
      expect(ROUTING_KEYS.outboundMessage).toBe('outbound.message');
      expect(QUEUES.coreInbound).toBe('core.inbound');
      expect(QUEUES.gatewayOutbound).toBe('gateway.outbound');
    });

    it('makeEnvelope 工厂函数能够正确包装事件并生成 UUID/时间戳', () => {
      const sampleInbound: InboundMessage = {
        tenantId: 2,
        channel: 'test',
        channelChatId: 'chat_test_1',
        channelMsgId: 'msg_test_1',
        sender: { role: 'CUSTOMER', channelUserId: 'u_1' },
        mentions: [],
        type: 'text',
        text: 'hello',
        sentAt: Date.now(),
      };

      const envelope = makeEnvelope('inbound.message', sampleInbound, {
        tenantId: 2,
      });

      expect(envelope.version).toBe(1);
      expect(envelope.type).toBe('inbound.message');
      expect(envelope.tenantId).toBe(2);
      expect(envelope.eventId).toBeDefined();
      expect(envelope.traceId).toBeDefined();
      expect(envelope.occurredAt).toBeLessThanOrEqual(Date.now());
      expect(envelope.payload.channelMsgId).toBe('msg_test_1');
    });
  });

  describe('4. Zod 结构化运行时校验 (schemas)', () => {
    it('IntentSpanSchema 能够成功校验合法意图片段', () => {
      const validSpan = {
        span: '问下延保多少钱',
        main: 'CONSULT',
        sub: 'consult_price',
        l3: null,
        product: '整车延保',
        confidence: 0.95,
      };

      const parsed = IntentSpanSchema.parse(validSpan);
      expect(parsed.main).toBe('CONSULT');
      expect(parsed.confidence).toBe(0.95);
    });

    it('IntentSpanSchema 拒绝置信度超出 [0, 1] 范围的非法数据', () => {
      const invalidSpan = {
        span: '非法置信度测试',
        main: 'CONSULT',
        sub: null,
        confidence: 1.5,
      };

      expect(() => IntentSpanSchema.parse(invalidSpan)).toThrow();
    });

    it('UnderstandOutputSchema 能够成功校验模型首轮结构化输出 (relation 为 null)', () => {
      const firstTurnOutput = {
        relation: null,
        relation_note: null,
        intents: [
          {
            span: '在吗，问下延保多少钱',
            main: 'CONSULT',
            sub: 'price',
            confidence: 0.92,
          },
        ],
        emotion: 'calm',
      };

      const parsed = UnderstandOutputSchema.parse(firstTurnOutput);
      expect(parsed.relation).toBeNull();
      expect(parsed.intents.length).toBe(1);
      expect(parsed.emotion).toBe('calm');
    });

    it('UnderstandOutputSchema 能够成功校验模型多轮接关输出 (relation 为 CONTINUE)', () => {
      const followUpOutput = {
        relation: 'CONTINUE',
        relation_note: '承接上轮问界M5延保价格，追问质保范围',
        intents: [
          {
            span: '那发动机保不保？',
            main: 'CONSULT',
            sub: 'coverage_engine',
            product: '整车延保',
            confidence: 0.98,
          },
        ],
        emotion: 'calm',
      };

      const parsed = UnderstandOutputSchema.parse(followUpOutput);
      expect(parsed.relation).toBe('CONTINUE');
      expect(parsed.relation_note).toContain('问界M5延保价格');
    });
  });

  describe('5. 自述化元数据常量字典契约 (Self-Describing Metadata Enums)', () => {
    it('出站消息类型字典 OUTBOUND_MESSAGE_KIND 包含完整 label、desc 与私信交接包标识', () => {
      expect(OUTBOUND_MESSAGE_KIND.REPLY.label).toBe('正式回复');
      expect(OUTBOUND_MESSAGE_KIND.PLACEHOLDER.label).toBe('占位安抚');
      expect(OUTBOUND_MESSAGE_KIND.HANDOFF_NOTICE.label).toBe('转人工通知');
      expect(OUTBOUND_MESSAGE_KIND.HANDOFF_PACKAGE.label).toBe('客服交接包');

      // 验证业务边界属性
      expect(OUTBOUND_MESSAGE_KIND.HANDOFF_PACKAGE.isPrivateOnly).toBe(true);
      expect(OUTBOUND_MESSAGE_KIND.REPLY.isPrivateOnly).toBe(false);
      expect(OUTBOUND_MESSAGE_KIND.PLACEHOLDER.desc).toContain('占位安抚');
    });

    it('渠道与群成员角色元数据字典结构完备', () => {
      expect(CHANNEL_TYPE.wecom_group.label).toBe('企微外部群');
      expect(CHANNEL_TYPE.wecom_single.label).toBe('企微单聊');
      expect(CHANNEL_TYPE.simulator.label).toBe('仿真模拟器');
      expect(CHANNEL_TYPE.test.label).toBe('测试注入');

      expect(MEMBER_ROLE.CUSTOMER.label).toBe('外部客户');
      expect(MEMBER_ROLE.STAFF_CS.label).toBe('专职客服');
      expect(MEMBER_ROLE.BOT.label).toBe('智能体机器人');
      expect(MEMBER_ROLE.STAFF_CS.desc).toContain('抢夺');
    });

    it('话筒归属 MIC_HOLDER 与接关关系 TURN_RELATION 正确自述', () => {
      expect(MIC_HOLDER.BOT.label).toBe('机器人持有');
      expect(MIC_HOLDER.HUMAN.label).toBe('人工持有');
      expect(MIC_HOLDER.HUMAN.desc).toContain('作废');

      expect(TURN_RELATION.CONTINUE.label).toBe('承接');
      expect(TURN_RELATION.CORRECT.label).toBe('纠正');
      expect(TURN_RELATION.NEW_TOPIC.label).toBe('换题');
      expect(TURN_RELATION.CLOSE.label).toBe('收尾');
      expect(TURN_RELATION.CORRECT.desc).toContain('挫败');
    });

    it('平台主意图 MAIN_INTENT 与动作 ACTION_TYPE 具备默认执行与优先级元数据', () => {
      expect(MAIN_INTENT.CONSULT.defaultAction).toBe('ANSWER');
      expect(MAIN_INTENT.CONSULT.defaultSource).toBe('RAG');

      expect(MAIN_INTENT.QUERY.defaultAction).toBe('ANSWER');
      expect(MAIN_INTENT.QUERY.defaultSource).toBe('TOOL');

      expect(MAIN_INTENT.HANDLE.defaultAction).toBe('GUIDE');
      expect(MAIN_INTENT.HANDLE.defaultSource).toBe('SCRIPT');

      expect(MAIN_INTENT.COMPLAINT.defaultAction).toBe('HANDOFF');

      // 动作优先级校验：HANDOFF(5) > GUIDE(3) > ANSWER(2) > FALLBACK(1)
      expect(ACTION_TYPE.HANDOFF.priority).toBeGreaterThan(ACTION_TYPE.GUIDE.priority);
      expect(ACTION_TYPE.GUIDE.priority).toBeGreaterThan(ACTION_TYPE.ANSWER.priority);
      expect(ACTION_TYPE.ANSWER.priority).toBeGreaterThan(ACTION_TYPE.FALLBACK.priority);
    });

    it('答案来源 ANSWER_SOURCE 与转人工 HANDOFF_TYPE 契约完备', () => {
      expect(ANSWER_SOURCE.RAG.label).toBe('知识库检索');
      expect(ANSWER_SOURCE.FAQ.label).toBe('问答对匹配');
      expect(ANSWER_SOURCE.SCRIPT.label).toBe('固定话术');
      expect(ANSWER_SOURCE.TOOL.label).toBe('业务系统工具');
      expect(ANSWER_SOURCE.PRICE_LIST.label).toBe('价目表');

      expect(HANDOFF_TYPE.SENSITIVE.label).toBe('敏感信息');
      expect(HANDOFF_TYPE.FRUSTRATION.desc).toContain('挫败');
      expect(HANDOFF_TYPE.BLIND_SPOT.label).toBe('知识盲区');
    });

    it('三层状态机与情绪感知元数据字典符合规范', () => {
      // 第一层会话状态
      expect(CONVERSATION_STATUS.QUEUED.label).toBe('排队中');
      expect(CONVERSATION_STATUS.ACTIVE.label).toBe('进行中');
      expect(CONVERSATION_STATUS.ENDED.label).toBe('已结束');

      // 第二层轮次状态
      expect(TURN_STATUS.IN_PROGRESS.label).toBe('进行中');
      expect(TURN_STATUS.DONE.label).toBe('已完成');

      // 第三层消息聚合组状态
      expect(GROUP_STATUS.COLLECTING.label).toBe('收集中');
      expect(GROUP_STATUS.UNDERSTANDING.label).toBe('理解中');
      expect(GROUP_STATUS.FINAL_CHECKING.label).toBe('末检中');
      expect(GROUP_STATUS.SENT.label).toBe('已发出');
      expect(GROUP_STATUS.ARCHIVED.label).toBe('已归档');
      expect(GROUP_STATUS.VOIDED.label).toBe('已作废');
      expect(GROUP_STATUS.VOIDED.desc).toContain('作废不发');

      // 情绪感知类型
      expect(EMOTION_TYPE.calm.label).toBe('平静');
      expect(EMOTION_TYPE.confused.label).toBe('困惑');
      expect(EMOTION_TYPE.anxious.label).toBe('焦虑');
      expect(EMOTION_TYPE.dissatisfied.label).toBe('不满');
      expect(EMOTION_TYPE.angry.label).toBe('愤怒');
    });
  });
});
