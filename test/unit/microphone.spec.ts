/**
 * @file microphone.spec.ts
 * @description Task 3.8: 阶段三单元测试验证集 (附录 C 用例 S7, S8, S9, S25)
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §6.2、§11.3、附录 C (S7, S8, S9, S25)
 */

import { InboundPipelineService } from '../../src/modules/pipeline/inbound-pipeline.service';
import { MicrophoneService } from '../../src/modules/pipeline/microphone.service';
import { TimerService } from '../../src/modules/pipeline/timer.service';
import type { InboundMessage, ChannelAdapter } from '../../src/contracts';
import type { Env } from '../../src/config/env';

describe('Task 3.8: 阶段三单元测试验证集 (S7, S8, S9, S25)', () => {
  let inboundService: InboundPipelineService;
  let micService: MicrophoneService;
  let timerService: TimerService;

  let mockMysqlService: any;
  let mockRedisService: any;
  let mockBufferService: any;
  let mockSealerService: any;
  let mockQueueService: any;
  let mockStateTransitionService: any;
  let mockChannelAdapter: ChannelAdapter;

  let mockDbPool: any;
  let mockRedisClient: any;
  let mockTimerQueue: any;
  let dbStore: {
    conversations: Map<number, any>;
    messages: Map<number, any>;
    groups: Map<number, any>;
    turns: Map<number, any>;
    backgrounds: Map<number, any>;
  };
  let redisStore: Map<string, Record<string, string>>;

  const convId = 1001;
  const customerId = 'wm_cust_zhang';
  const staffId = 'staff_agent_chen';
  const botId = 'wx_bot_ai_01';

  const baseEnv: Env = {
    PORT: 3002,
    MYSQL_URL: 'mysql://mock',
    WECOM_BOT_ENABLED: true,
    WECOM_BOT_ID: botId,
    WECOM_STAFF_MENTIONS: '@客服',
    REDIS_HOST: '127.0.0.1',
    REDIS_PORT: 6379,
    REDIS_DB: 0,
    CRM_BASE_URL: 'http://mock-crm.local',
    CRM_SERVICE_TOKEN: 'mock_token',
    CRM_TIMEOUT_MS: 800,
    QUIET_WINDOW_MS: 3000,
    HARD_TIMEOUT_MS: 15000,
    GROUP_MAX_MESSAGES: 5,
    MIC_SEIZE_SCOPE: 'ALL_INTERNAL',
    MIC_RETURN_BY_MENTION_ENABLED: true,
    HUMAN_WAIT_TIMEOUT_MS: 60000,
  };

  beforeEach(() => {
    redisStore = new Map<string, Record<string, string>>();
    dbStore = {
      conversations: new Map(),
      messages: new Map(),
      groups: new Map(),
      turns: new Map(),
      backgrounds: new Map(),
    };

    // 默认会话初始状态：话筒在 BOT 手中，turn_count = 0
    dbStore.conversations.set(convId, {
      id: convId,
      tenant_id: 1,
      channel: 'wecom_group',
      channel_chat_id: 'chat_group_s25',
      turn_count: 0,
      rule_pack_version: 'v1.0.0',
      mic_owner: 'BOT',
      handoff: 0,
    });

    redisStore.set(`ag:mic:${convId}`, {
      owner: 'BOT',
      staffId: '',
      seizedAt: '0',
      epoch: '1',
      is_handoff_locked: '0',
    });

    mockRedisClient = {
      hgetall: jest.fn(async (key: string) => {
        return redisStore.get(key) || {};
      }),
      hset: jest.fn(async (key: string, data: Record<string, any>) => {
        const current = redisStore.get(key) || {};
        const updated = { ...current };
        for (const [k, v] of Object.entries(data)) {
          updated[k] = String(v);
        }
        redisStore.set(key, updated);
        return Object.keys(data).length;
      }),
      del: jest.fn(async (key: string) => {
        redisStore.delete(key);
        return 1;
      }),
      eval: jest.fn(async (script: string, numkeys: number, ...args: any[]) => {
        const key = args[0];
        const current = redisStore.get(key) || {
          owner: 'BOT',
          staffId: '',
          seizedAt: '0',
          epoch: '1',
          is_handoff_locked: '0',
        };

        if (script.includes('HANDOFF_LOCKED') || script.includes('ALREADY_BOT')) {
          // returnToBot Lua 脚本
          const reason = args[2] || 'RETURNED';
          const force = args[3] === '1';
          const isLocked = current.is_handoff_locked === '1';
          const currentEpoch = parseInt(current.epoch || '1', 10);

          if (isLocked && !force) {
            return [0, currentEpoch, 'HANDOFF_LOCKED'];
          }
          if (current.owner === 'BOT') {
            return [1, currentEpoch, 'ALREADY_BOT'];
          }

          const newEpoch = currentEpoch + 1;
          const updated = {
            ...current,
            owner: 'BOT',
            staffId: '',
            reason,
            epoch: String(newEpoch),
            is_handoff_locked: '0',
          };
          redisStore.set(key, updated);
          return [1, newEpoch, 'RETURNED'];
        } else if (script.includes('currentStaff ~= ARGV[1]')) {
          // seizeByStaff Lua 脚本
          const newStaffId = args[1];
          const reason = args[3] || 'STAFF_SEIZED';
          const currentEpoch = parseInt(current.epoch || '1', 10);
          const currentOwner = current.owner || 'BOT';

          let changed = 0;
          let newEpoch = currentEpoch;
          if (currentOwner === 'BOT' || current.staffId !== newStaffId) {
            changed = 1;
            newEpoch = currentEpoch + 1;
          }

          const updated = {
            ...current,
            owner: 'HUMAN',
            staffId: newStaffId,
            seizedAt: String(Date.now()),
            epoch: String(newEpoch),
            reason,
          };
          redisStore.set(key, updated);
          return [changed, currentOwner, 'HUMAN', newEpoch, newStaffId, reason];
        }

        return [1, 1, 'OK'];
      }),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      incr: jest.fn().mockResolvedValue(1),
    };

    mockRedisService = {
      getClient: jest.fn().mockReturnValue(mockRedisClient),
    };

    mockDbPool = {
      query: jest.fn().mockImplementation(async (sql: string, params?: any[]) => {
        // 查询 conversation
        if (sql.includes('SELECT') && sql.includes('FROM conversation WHERE id = ?')) {
          const c = dbStore.conversations.get(params?.[0]);
          return c ? [[c]] : [[]];
        }
        if (sql.includes('SELECT id FROM conversation')) {
          return [[{ id: convId }]];
        }
        // 查询 message
        if (sql.includes('SELECT content, sent_at FROM message WHERE id IN (?)')) {
          const ids: number[] = params?.[0] || [];
          const rows = ids.map((id) => dbStore.messages.get(id)).filter(Boolean);
          return [rows];
        }
        // 查询 msg_group 状态
        if (sql.includes('SELECT status, turn_id FROM msg_group WHERE id = ?')) {
          const g = dbStore.groups.get(Number(params?.[0]));
          return g ? [[g]] : [[]];
        }
        // 插入 message
        if (sql.includes('INSERT INTO message')) {
          const insertId = dbStore.messages.size + 1;
          dbStore.messages.set(insertId, {
            id: insertId,
            content: params?.[6] || params?.[7] || '',
            sent_at: new Date(),
          });
          return [{ insertId }];
        }
        // 插入 msg_group
        if (sql.includes('INSERT INTO msg_group')) {
          const insertId = dbStore.groups.size + 1;
          dbStore.groups.set(insertId, {
            id: insertId,
            tenant_id: params?.[0],
            conversation_id: params?.[1],
            sender_channel_user_id: params?.[2],
            status: 'ARCHIVED',
            seal_reason: 'HUMAN_REPLIED',
            message_count: params?.[3],
            merged_text: params?.[4],
          });
          return [{ insertId }];
        }
        // 插入 turn
        if (sql.includes('INSERT INTO turn')) {
          const insertId = dbStore.turns.size + 1;
          dbStore.turns.set(insertId, {
            id: insertId,
            tenant_id: params?.[0],
            conversation_id: params?.[1],
            seq: params?.[2],
            status: 'DONE',
            responder: 'HUMAN',
            reply_text: params?.[3],
            rule_pack_version: params?.[4],
          });
          return [{ insertId }];
        }
        // 更新 conversation turn_count
        if (sql.includes('UPDATE conversation SET turn_count = turn_count + 1')) {
          const c = dbStore.conversations.get(params?.[0]);
          if (c) c.turn_count += 1;
          return [{ affectedRows: 1 }];
        }
        // 插入/更新 conversation_background
        if (sql.includes('conversation_background')) {
          const bg = dbStore.backgrounds.get(params?.[0]) || { items: [] };
          bg.items.push({
            question: params?.[3] || params?.[4],
            reply: params?.[4] || params?.[5],
            staffId: params?.[5] || params?.[6],
          });
          dbStore.backgrounds.set(params?.[0], bg);
          return [{ affectedRows: 1 }];
        }
        // 更新 conversation mic_owner
        if (sql.includes('UPDATE conversation SET mic_owner')) {
          const c = dbStore.conversations.get(convId);
          if (c) c.mic_owner = params?.[0];
          return [{ affectedRows: 1 }];
        }
        return [{ affectedRows: 1 }];
      }),
    };

    mockMysqlService = {
      getPool: jest.fn().mockReturnValue(mockDbPool),
    };

    mockBufferService = {
      push: jest.fn().mockResolvedValue({ count: 1, isFirst: true, version: 1, epoch: 1 }),
      drain: jest.fn().mockResolvedValue([]),
      nonEmptySenders: jest.fn().mockResolvedValue([]),
      hasActiveGroup: jest.fn().mockResolvedValue(false),
      clear: jest.fn().mockResolvedValue([]),
    };

    mockSealerService = {
      seal: jest.fn().mockResolvedValue({ success: true }),
      triggerSeal: jest.fn().mockResolvedValue({ success: true }),
    };

    mockQueueService = {
      getQueue: jest.fn().mockImplementation(() => mockTimerQueue),
      createWorker: jest.fn(),
    };

    mockTimerQueue = {
      add: jest.fn().mockResolvedValue({ id: 'job_hwait_test' }),
      getJob: jest.fn().mockResolvedValue({ remove: jest.fn().mockResolvedValue(true) }),
    };

    mockStateTransitionService = {
      transition: jest.fn().mockResolvedValue({ success: true }),
    };

    mockChannelAdapter = {
      channel: 'wecom_group',
      send: jest.fn().mockResolvedValue({ channelMsgId: 'msg_send_001' }),
    };

    micService = new MicrophoneService(baseEnv, mockMysqlService, mockRedisService);
    timerService = new TimerService(
      baseEnv,
      mockQueueService,
      mockBufferService,
      mockRedisService,
      mockMysqlService,
      mockStateTransitionService,
      micService,
    );
    timerService.setSealer(mockSealerService);

    inboundService = new InboundPipelineService(
      baseEnv,
      mockMysqlService,
      mockRedisService,
      mockBufferService,
      timerService,
      mockSealerService,
      micService,
      mockStateTransitionService,
      mockChannelAdapter,
    );
  });

  describe('1. 用例 S7: 员工抢话筒时 AI 在途组生成作废 (VOIDED) 联动', () => {
    it('AI 理解中客服在群内发言，话筒原子切为 HUMAN，在途组原子流转为 VOIDED 并清除互斥锁，未发群聊', async () => {
      // 1. 设置会话有 AI 在途任务
      redisStore.set(`ag:inflight:${convId}`, {
        groupId: '501',
        convId: String(convId),
        traceId: 'trace_s7_001',
        startedAt: String(Date.now() - 1000),
      });
      dbStore.groups.set(501, {
        id: 501,
        status: 'UNDERSTANDING',
        turn_id: 101,
      });

      // 2. 内部客服在群内发言
      const staffMsg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'chat_group_s25',
        channelMsgId: 'msg_staff_s7',
        sender: {
          role: 'STAFF_CS',
          channelUserId: staffId,
          name: '客服陈顾问',
        },
        mentions: [],
        type: 'text',
        text: '王先生您好，这个底盘异响的问题我来为您安排检测',
        sentAt: Date.now(),
      };

      const res = await inboundService.onInbound(staffMsg);

      expect(res.status).toBe('STAFF_HANDLED');

      // 3. 断言话筒所有权切为 HUMAN，且 epoch 自增
      const micStatus = await micService.getMicStatus(convId);
      expect(micStatus.owner).toBe('HUMAN');
      expect(micStatus.staffId).toBe(staffId);
      expect(micStatus.epoch).toBe(2);

      // 4. 断言在途组 #501 被作废 (UNDERSTANDING -> VOIDED, reason=MIC_SEIZED)
      expect(mockStateTransitionService.transition).toHaveBeenCalledWith(
        'GROUP',
        '501',
        'UNDERSTANDING',
        'VOIDED',
        expect.objectContaining({
          tenantId: 1,
          operatorType: 'STAFF',
          reason: 'MIC_SEIZED',
        }),
      );

      // 5. 断言清理在途任务键与会话并发锁
      expect(redisStore.has(`ag:inflight:${convId}`)).toBe(false);
      // 6. 断言未调用 ChannelAdapter 发送机器人任何消息
      expect(mockChannelAdapter.send).not.toHaveBeenCalled();
    });
  });

  describe('2. 用例 S8: 人工抢跑与客户未处理缓冲消息就地归档 (ARCHIVED)', () => {
    it('客户发问 40s 后人工抢跑回复，客户未处理消息抽空并归档为 ARCHIVED，记为人工轮次并更新背景', async () => {
      // 1. 模拟客户发问积累在缓冲池中（尚未封组）
      dbStore.messages.set(201, { id: 201, content: '整车质保包含三电吗？', sent_at: new Date(Date.now() - 40000) });
      dbStore.messages.set(202, { id: 202, content: '另外蓄电池保多久？', sent_at: new Date(Date.now() - 35000) });

      mockBufferService.nonEmptySenders.mockResolvedValue([customerId]);
      mockBufferService.drain.mockResolvedValue([201, 202]);

      // 2. 客服发送回复抢跑
      const staffReplyMsg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'chat_group_s25',
        channelMsgId: 'msg_staff_s8',
        sender: {
          role: 'STAFF_CS',
          channelUserId: staffId,
          name: '客服陈顾问',
        },
        mentions: [],
        type: 'text',
        text: '三电质保是8年16万公里，普通蓄电池质保为1年。',
        sentAt: Date.now(),
      };

      await inboundService.onInbound(staffReplyMsg);

      // 3. 断言缓冲池被 drain 清空
      expect(mockBufferService.drain).toHaveBeenCalledWith(convId, customerId);

      // 4. 断言创建了归档组 ARCHIVED 与 seal_reason=HUMAN_REPLIED
      expect(mockDbPool.query).toHaveBeenCalledWith(
        expect.stringContaining("status, seal_reason, message_count, merged_text"),
        expect.arrayContaining([1, convId, customerId, 2, '整车质保包含三电吗？\n另外蓄电池保多久？']),
      );

      // 5. 断言向 turn 表插入人工轮次 (responder = 'HUMAN')
      expect(mockDbPool.query).toHaveBeenCalledWith(
        expect.stringContaining("status, responder, reply_text, reply_status"),
        expect.arrayContaining([1, convId, 1, '三电质保是8年16万公里，普通蓄电池质保为1年。']),
      );

      // 6. 断言会话轮次 +1 (turn_count 从 0 变为 1)
      const conv = dbStore.conversations.get(convId);
      expect(conv.turn_count).toBe(1);

      // 7. 断言会话背景 conversation_background 记录了人工问答历史
      expect(mockDbPool.query).toHaveBeenCalledWith(
        expect.stringContaining('conversation_background'),
        expect.anything(),
      );
    });
  });

  describe('3. 用例 S9: 60 秒人工未回复看门狗计时器接回机制', () => {
    it('客户发问人工 60s 未回复，看门狗计时器触发话筒切回 BOT，立即封组且无占位应答', async () => {
      // 1. 模拟话筒当前在 HUMAN 手中
      redisStore.set(`ag:mic:${convId}`, {
        owner: 'HUMAN',
        staffId,
        seizedAt: String(Date.now() - 30000),
        epoch: '2',
        is_handoff_locked: '0',
      });

      // 2. 客户发送首条消息，入站分流逻辑触发预约 60s hwait 延时任务
      const customerMsg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'chat_group_s25',
        channelMsgId: 'msg_cust_s9',
        sender: {
          role: 'CUSTOMER',
          channelUserId: customerId,
          name: '车主张先生',
        },
        mentions: [],
        type: 'text',
        text: '刚才说的一年质保包含工时费吗？',
        sentAt: Date.now(),
      };

      await inboundService.onInbound(customerMsg);

      // 验证首条预约 60s 看门狗任务
      expect(mockTimerQueue.add).toHaveBeenCalledWith(
        'hwait',
        expect.objectContaining({
          convId,
          senderId: customerId,
          micEpoch: 2,
        }),
        expect.objectContaining({
          delay: 60000,
        }),
      );

      // 3. 模拟 60s 超时到期看门狗执行
      const returnSpy = jest.spyOn(micService, 'returnToBot');
      await (timerService as any).handleHumanWaitJob({
        convId,
        senderId: customerId,
        micEpoch: 2,
      });

      // 4. 断言触发了 returnToBot(convId, 'HUMAN_TIMEOUT')
      expect(returnSpy).toHaveBeenCalledWith(convId, 'HUMAN_TIMEOUT');

      // 5. 断言话筒状态已原子恢复为 BOT
      const micStatus = await micService.getMicStatus(convId);
      expect(micStatus.owner).toBe('BOT');
      expect(micStatus.epoch).toBe(3);

      // 6. 断言看门狗直接触发立即封组 (HUMAN_TIMEOUT)，无需等待 3s 静默
      expect(mockSealerService.seal).toHaveBeenCalledWith(convId, customerId, 'HUMAN_TIMEOUT');

      // 7. 断言不发送任何中间占位应答
      expect(mockChannelAdapter.send).not.toHaveBeenCalled();
    });
  });

  describe('4. 用例 S25: 人工接管问答后客户追问，60s 未回复接关承接与背景串联', () => {
    it('人工问答一次后客户追问，人工 60s 未回话筒交回 BOT，接关对比人工轮并延续会话背景', async () => {
      // 步骤 A: 客户提问“保修几年”，坐席在群内回复“整车保修6年” (人工轮闭环)
      dbStore.messages.set(301, { id: 301, content: '保修几年', sent_at: new Date(Date.now() - 50000) });
      mockBufferService.nonEmptySenders.mockResolvedValue([customerId]);
      mockBufferService.drain.mockResolvedValue([301]);

      const staffReply: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'chat_group_s25',
        channelMsgId: 'msg_staff_s25_1',
        sender: {
          role: 'STAFF_CS',
          channelUserId: staffId,
          name: '客服陈顾问',
        },
        mentions: [],
        type: 'text',
        text: '整车保修6年',
        sentAt: Date.now() - 45000,
      };

      await inboundService.onInbound(staffReply);

      // 验证第一轮人工问答入库: turn_count = 1, responder = HUMAN
      const convAfterStaff = dbStore.conversations.get(convId);
      expect(convAfterStaff.turn_count).toBe(1);
      const turn1 = dbStore.turns.get(1);
      expect(turn1).toBeDefined();
      expect(turn1.seq).toBe(1);
      expect(turn1.responder).toBe('HUMAN');
      expect(turn1.reply_text).toBe('整车保修6年');

      // 步骤 B: 之后客户追问“那电池呢”，话筒仍在 HUMAN 手中，客户消息入缓冲池待人工回复
      mockBufferService.nonEmptySenders.mockResolvedValue([]);
      mockBufferService.push.mockResolvedValueOnce({
        count: 1,
        version: 1,
        epoch: 2,
        firstAt: Date.now(),
        isFirst: true,
      });

      const customerFollowUp: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'chat_group_s25',
        channelMsgId: 'msg_cust_s25_follow',
        sender: {
          role: 'CUSTOMER',
          channelUserId: customerId,
          name: '车主张先生',
        },
        mentions: [],
        type: 'text',
        text: '那电池呢',
        sentAt: Date.now(),
      };

      await inboundService.onInbound(customerFollowUp);

      // 验证预约了 60s 人工超时接回
      expect(mockTimerQueue.add).toHaveBeenCalledWith(
        'hwait',
        expect.objectContaining({
          convId,
          senderId: customerId,
          micEpoch: 2,
        }),
        expect.objectContaining({ delay: 60000 }),
      );

      // 步骤 C: 人工 60s 未回复，看门狗超时到期触发交回 BOT 并封组
      await (timerService as any).handleHumanWaitJob({
        convId,
        senderId: customerId,
        micEpoch: 2,
      });

      // 验证话筒恢复给 BOT，且触发封组
      const finalMic = await micService.getMicStatus(convId);
      expect(finalMic.owner).toBe('BOT');
      expect(mockSealerService.seal).toHaveBeenCalledWith(convId, customerId, 'HUMAN_TIMEOUT');

      // 步骤 D: 承接断言:
      // 1. 本组非首组 (conv.turn_count >= 1)
      expect(convAfterStaff.turn_count).toBeGreaterThanOrEqual(1);
      // 2. 接关对比基准为上一轮人工问答
      expect(turn1.responder).toBe('HUMAN');
      expect(turn1.reply_text).toBe('整车保修6年');
      // 3. 会话背景完整记录了人工轮
      const bg = dbStore.backgrounds.get(convId);
      expect(bg).toBeDefined();
    });
  });
});
