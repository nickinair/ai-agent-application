/**
 * @file test-inject-suite.spec.ts
 * @description Task 5.1: 测试注入接口测试套件自检与验证单测
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §5.3、§13.1、§13.2
 */

import { TestInjectSuite } from './test-inject-suite';
import { InboundPipelineService } from '../../src/modules/pipeline/inbound-pipeline.service';
import { MysqlService } from '../../src/database/mysql.service';
import { RedisService } from '../../src/infra/redis/redis.service';
import { MicrophoneService } from '../../src/modules/pipeline/microphone.service';
import { BufferService } from '../../src/modules/pipeline/buffer.service';
import type { InboundMessage } from '../../src/contracts';

describe('Task 5.1: 测试注入接口测试套件 (TestInjectSuite) 功能测试', () => {
  let suite: TestInjectSuite;
  let mockInboundService: InboundPipelineService;
  let mockMysqlService: MysqlService;
  let mockMicService: MicrophoneService;
  let mockBufferService: BufferService;

  let injectedList: InboundMessage[];
  let dbTables: {
    msg_group: Map<number, any>;
    turn: Map<number, any>;
    conversation: Map<number, any>;
  };

  beforeEach(() => {
    injectedList = [];
    dbTables = {
      msg_group: new Map(),
      turn: new Map(),
      conversation: new Map(),
    };

    // 1. Mock InboundPipelineService
    mockInboundService = {
      onInbound: jest.fn().mockImplementation(async (msg: InboundMessage) => {
        injectedList.push(msg);
        return {
          status: 'PROCESSED' as const,
          messageId: injectedList.length,
          conversationId: 10001,
        };
      }),
    } as unknown as InboundPipelineService;

    // 2. Mock MysqlService
    mockMysqlService = {
      getPool: () => ({
        query: async (sql: string, params: any[]) => {
          if (sql.includes('FROM msg_group WHERE id = ?')) {
            const row = dbTables.msg_group.get(params[0]);
            return [row ? [row] : []];
          }
          if (sql.includes('FROM turn WHERE id = ?')) {
            const row = dbTables.turn.get(params[0]);
            return [row ? [row] : []];
          }
          if (sql.includes('FROM conversation WHERE id = ?')) {
            const row = dbTables.conversation.get(params[0]);
            return [row ? [row] : []];
          }
          return [[]];
        },
      }),
    } as unknown as MysqlService;

    // 3. Mock MicrophoneService
    mockMicService = {
      getMicStatus: jest.fn().mockResolvedValue({
        owner: 'BOT',
        staffId: null,
        epoch: 1,
      }),
    } as unknown as MicrophoneService;

    // 4. Mock BufferService
    mockBufferService = {
      peekSince: jest.fn().mockResolvedValue([
        { channelMsgId: 'm1', text: 'msg1' },
        { channelMsgId: 'm2', text: 'msg2' },
      ]),
    } as unknown as BufferService;

    suite = new TestInjectSuite(
      mockInboundService,
      mockMysqlService,
      undefined,
      mockMicService,
      mockBufferService,
    );
  });

  describe('1. 消息构造与单条/批量注入能力', () => {
    it('buildInboundMessage 应规范补齐默认值与角色', () => {
      const msg = suite.buildInboundMessage({
        chatId: 'chat_test_01',
        senderId: 'wm_cust_01',
        text: '你好，问下保养价格',
      });

      expect(msg.tenantId).toBe(1);
      expect(msg.channel).toBe('test');
      expect(msg.channelChatId).toBe('chat_test_01');
      expect(msg.sender.role).toBe('CUSTOMER');
      expect(msg.sender.channelUserId).toBe('wm_cust_01');
      expect(msg.text).toBe('你好，问下保养价格');
      expect(msg.channelMsgId).toMatch(/^test-/);
    });

    it('injectMessage 支持单条注入', async () => {
      const res = await suite.injectMessage({
        chatId: 'chat_test_01',
        senderId: 'wm_cust_01',
        text: '单条测试消息',
      });

      expect(res.status).toBe('PROCESSED');
      expect(mockInboundService.onInbound).toHaveBeenCalledTimes(1);
      expect(injectedList[0].text).toBe('单条测试消息');
    });

    it('injectSequence 支持多角色时序模拟', async () => {
      const startTime = Date.now();
      const results = await suite.injectSequence([
        {
          chatId: 'chat_seq_01',
          senderId: 'wm_cust_01',
          role: 'CUSTOMER',
          text: '消息1',
        },
        {
          chatId: 'chat_seq_01',
          senderId: 'wm_cust_01',
          role: 'CUSTOMER',
          text: '消息2（连发）',
          delayMs: 30,
        },
        {
          chatId: 'chat_seq_01',
          senderId: 'staff_agent_chen',
          role: 'STAFF_CS',
          text: '人工插话抢话筒',
          delayMs: 20,
        },
      ]);

      const elapsed = Date.now() - startTime;
      expect(results.length).toBe(3);
      expect(mockInboundService.onInbound).toHaveBeenCalledTimes(3);
      expect(injectedList[0].sender.role).toBe('CUSTOMER');
      expect(injectedList[1].text).toBe('消息2（连发）');
      expect(injectedList[2].sender.role).toBe('STAFF_CS');
      expect(elapsed).toBeGreaterThanOrEqual(45);
    });
  });

  describe('2. 异步轮询等待辅助器', () => {
    it('waitForCondition 在满足条件时立即成功返回', async () => {
      let counter = 0;
      setTimeout(() => {
        counter = 10;
      }, 50);

      await expect(
        suite.waitForCondition(async () => counter >= 10, 1000, 20),
      ).resolves.toBeUndefined();
    });

    it('waitForCondition 超时未达成期望条件时抛出错误', async () => {
      await expect(
        suite.waitForCondition(async () => false, 100, 20),
      ).rejects.toThrow('等待超时');
    });

    it('waitForGroupSeal 成功捕获封组完成状态', async () => {
      const groupId = 501;
      // 模拟 40ms 后封组完成
      setTimeout(() => {
        dbTables.msg_group.set(groupId, {
          id: groupId,
          conversation_id: 10001,
          status: 'UNDERSTANDING',
          message_count: 2,
          text: '两句话合并文本',
          sealed_at: new Date(),
        });
      }, 40);

      const group = await suite.waitForGroupSeal(groupId, 1000);
      expect(group).toBeDefined();
      expect(group.id).toBe(groupId);
      expect(group.status).toBe('UNDERSTANDING');
      expect(group.message_count).toBe(2);
    });

    it('waitForTurnCompletion 成功捕获问答轮次结束状态与作废审计', async () => {
      const turnId = 701;
      // 模拟 40ms 后轮次因话筒被抢作废
      setTimeout(() => {
        dbTables.turn.set(turnId, {
          id: turnId,
          conversation_id: 10001,
          group_id: 501,
          status: 'DONE',
          reply_status: 'VOIDED',
          reply_text: '草稿文本',
          void_reason: 'MIC_SEIZED',
          finished_at: new Date(),
        });
      }, 40);

      const trace = await suite.waitForTurnCompletion(turnId, 1000);
      expect(trace.turnId).toBe(turnId);
      expect(trace.status).toBe('DONE');
      expect(trace.replyStatus).toBe('VOIDED');
      expect(trace.voidReason).toBe('MIC_SEIZED');
      expect(trace.replyText).toBe('草稿文本');
    });
  });

  describe('3. 状态快照与轨迹提取能力', () => {
    it('getConversationState 聚合会话、话筒所有权及缓冲池状态', async () => {
      dbTables.conversation.set(10001, {
        id: 10001,
        channel_chat_id: 'chat_test_01',
        status: 'ACTIVE',
      });

      const state = await suite.getConversationState(10001);
      expect(state).toBeDefined();
      expect(state?.conversationId).toBe(10001);
      expect(state?.channelChatId).toBe('chat_test_01');
      expect(state?.status).toBe('ACTIVE');
      expect(state?.micOwner).toBe('BOT');
      expect(state?.bufferedMessageCount).toBe(2);
    });
  });
});
