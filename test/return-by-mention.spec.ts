/**
 * @file return-by-mention.spec.ts
 * @description Task 3.7: @机器人 交还话筒开关控制与专属交还语下发单元测试 (附录 C 用例 S10)
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §6.2、§11.3、附录 C 用例 S10
 */

import { InboundPipelineService } from '../src/modules/pipeline/inbound-pipeline.service';
import { MicrophoneService } from '../src/modules/pipeline/microphone.service';
import type { ChannelAdapter, InboundMessage } from '../src/contracts';
import type { Env } from '../src/config/env';

describe('Task 3.7: @机器人 交还话筒开关控制测试 (S10 用例)', () => {
  let pipelineService: InboundPipelineService;
  let microphoneService: MicrophoneService;
  let mockMysqlService: any;
  let mockRedisService: any;
  let mockBufferService: any;
  let mockTimerService: any;
  let mockSealerService: any;
  let mockStateTransitionService: any;
  let mockChannelAdapter: ChannelAdapter;
  let mockDbPool: any;
  let redisStore: Map<string, Record<string, string>>;

  const convId = 777;
  const staffId = 'staff_agent_chen';
  const customerId = 'wm_cust_999';
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
    MIC_RETURN_BY_MENTION_ENABLED: false, // 默认关闭 (V1.0 评审决定)
  };

  beforeEach(() => {
    redisStore = new Map<string, Record<string, string>>();

    // 初始化 Redis 话筒持有状态为人工 (HUMAN)
    redisStore.set(`ag:mic:${convId}`, {
      owner: 'HUMAN',
      staffId,
      seizedAt: String(Date.now()),
      epoch: '3',
      is_handoff_locked: '0',
    });

    const mockRedisClient = {
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
      del: jest.fn().mockResolvedValue(1),
    };

    mockRedisService = {
      getClient: jest.fn().mockReturnValue(mockRedisClient),
    };

    mockDbPool = {
      query: jest.fn(async (sql: string, params: any[]) => {
        if (sql.includes('SELECT') && sql.includes('conversation')) {
          return [[{ id: convId, tenant_id: 1, channel: 'wecom_group', channel_chat_id: 'chat_777' }]];
        }
        return [{ affectedRows: 1 }];
      }),
    };

    mockMysqlService = {
      getPool: jest.fn().mockReturnValue(mockDbPool),
    };

    mockBufferService = {
      push: jest.fn().mockResolvedValue({ count: 1, isFirst: true }),
      hasActiveGroup: jest.fn().mockResolvedValue(false),
      clear: jest.fn().mockResolvedValue([]),
    };

    mockTimerService = {
      cancelHumanWait: jest.fn().mockResolvedValue(true),
      scheduleHumanWait: jest.fn().mockResolvedValue(true),
      scheduleQuiet: jest.fn().mockResolvedValue(true),
      scheduleHard: jest.fn().mockResolvedValue(true),
      scheduleIdle: jest.fn().mockResolvedValue(1),
    };

    mockSealerService = {
      seal: jest.fn().mockResolvedValue({}),
      triggerSeal: jest.fn().mockResolvedValue({}),
    };

    mockStateTransitionService = {
      transition: jest.fn().mockResolvedValue(true),
    };

    mockChannelAdapter = {
      channel: 'wecom_group',
      send: jest.fn().mockResolvedValue({ channelMsgId: 'msg_ack_s10' }),
    };

    microphoneService = new MicrophoneService(baseEnv, mockMysqlService, mockRedisService);
  });

  const createPipeline = (envOverrides: Partial<Env> = {}) => {
    const env = { ...baseEnv, ...envOverrides };
    const mic = new MicrophoneService(env, mockMysqlService, mockRedisService);
    return {
      pipeline: new InboundPipelineService(
        env,
        mockMysqlService,
        mockRedisService,
        mockBufferService,
        mockTimerService,
        mockSealerService,
        mic,
        mockStateTransitionService,
        mockChannelAdapter,
      ),
      mic,
    };
  };

  describe('1. 默认关闭开关 (mic_return_by_mention_enabled=false) 防误切保护', () => {
    it('当开关为 false 时，内部坐席在群内 @机器人 发言不交还话筒，保持 HUMAN 且绝不下发交还欢迎语', async () => {
      const { pipeline, mic } = createPipeline({ MIC_RETURN_BY_MENTION_ENABLED: false });
      const returnSpy = jest.spyOn(mic, 'returnByMention');

      const staffMentionMsg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'chat_777',
        channelMsgId: 'msg_staff_001',
        sender: {
          role: 'STAFF_CS',
          channelUserId: staffId,
          name: '客服陈经理',
        },
        mentions: ['BOT', botId],
        type: 'text',
        text: '@机器人 我跟客户已沟通完毕',
        sentAt: Date.now(),
      };

      await pipeline.onInbound(staffMentionMsg);

      // 断言: returnByMention 未被调用
      expect(returnSpy).not.toHaveBeenCalled();

      // 断言: 话筒所有权依然保持为 HUMAN
      const micStatus = await mic.getMicStatus(convId);
      expect(micStatus.owner).toBe('HUMAN');

      // 断言: 渠道发送接口绝不下发交还欢迎语
      expect(mockChannelAdapter.send).not.toHaveBeenCalled();
    });
  });

  describe('2. 开关开启联动 (mic_return_by_mention_enabled=true) 与专属交还语下发 (附录 C 用例 S10)', () => {
    it('当开关为 true 时，坐席 @机器人 发言原子切回 BOT，自增 epoch 并下发专属交还欢迎语', async () => {
      const { pipeline, mic } = createPipeline({ MIC_RETURN_BY_MENTION_ENABLED: true });
      const returnSpy = jest.spyOn(mic, 'returnByMention');

      const staffMentionMsg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'chat_777',
        channelMsgId: 'msg_staff_002',
        sender: {
          role: 'STAFF_CS',
          channelUserId: staffId,
          name: '客服陈经理',
        },
        mentions: ['BOT'],
        type: 'text',
        text: '@机器人 接下来交给你继续服务',
        sentAt: Date.now(),
      };

      await pipeline.onInbound(staffMentionMsg);

      // 1. 断言触发了 returnByMention
      expect(returnSpy).toHaveBeenCalledWith(convId, staffId);

      // 2. 断言 Redis 话筒状态原子切回 BOT，且 epoch 自增
      const micStatus = await mic.getMicStatus(convId);
      expect(micStatus.owner).toBe('BOT');
      expect(micStatus.epoch).toBe(4);

      // 3. 断言取消了 60s 人工超时任务
      expect(mockTimerService.cancelHumanWait).toHaveBeenCalledWith(convId, 4);

      // 4. 断言 ChannelAdapter.send 成功向群聊发送专属交还占位语
      expect(mockChannelAdapter.send).toHaveBeenCalledTimes(1);
      expect(mockChannelAdapter.send).toHaveBeenCalledWith({
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'chat_777',
        kind: 'PLACEHOLDER',
        text: '尊敬的客户，您好，我是您的专属客服，接下来由我持续为您服务！',
        conversationId: convId,
      });
    });

    it('通过文本正文 @机器人 形式也能正确识别交还意图', async () => {
      const { pipeline, mic } = createPipeline({ MIC_RETURN_BY_MENTION_ENABLED: true });

      const textMentionMsg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'chat_777',
        channelMsgId: 'msg_staff_003',
        sender: {
          role: 'STAFF_OTHER',
          channelUserId: 'staff_tech_01',
          name: '技术顾问李工',
        },
        mentions: [], // 模拟企微文本直接输入 @机器人 但未带 mentions 列表
        type: 'text',
        text: '@机器人 接管下这个用户的提问',
        sentAt: Date.now(),
      };

      await pipeline.onInbound(textMentionMsg);

      const micStatus = await mic.getMicStatus(convId);
      expect(micStatus.owner).toBe('BOT');
      expect(mockChannelAdapter.send).toHaveBeenCalledWith(
        expect.objectContaining({
          text: '尊敬的客户，您好，我是您的专属客服，接下来由我持续为您服务！',
        }),
      );
    });
  });

  describe('3. 开关开启下普通员工发言隔离', () => {
    it('员工日常发言（未 @机器人）正常抢占/保持话筒为 HUMAN，绝不下发交还语', async () => {
      const { pipeline, mic } = createPipeline({ MIC_RETURN_BY_MENTION_ENABLED: true });
      const returnSpy = jest.spyOn(mic, 'returnByMention');

      const normalStaffMsg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'chat_777',
        channelMsgId: 'msg_staff_004',
        sender: {
          role: 'STAFF_CS',
          channelUserId: staffId,
          name: '客服陈经理',
        },
        mentions: [],
        type: 'text',
        text: '好的李先生，这个配件目前店里有现货，明天可以安排',
        sentAt: Date.now(),
      };

      await pipeline.onInbound(normalStaffMsg);

      expect(returnSpy).not.toHaveBeenCalled();
      const micStatus = await mic.getMicStatus(convId);
      expect(micStatus.owner).toBe('HUMAN');
      expect(mockChannelAdapter.send).not.toHaveBeenCalled();
    });
  });

  describe('4. 强制解锁主动转人工锁定状态 (is_handoff_locked=1)', () => {
    it('在处于主动转人工锁定状态下，开启开关的 @机器人 成功解除锁定并将话筒切回 BOT', async () => {
      // 预先模拟主动转人工锁定状态
      redisStore.set(`ag:mic:${convId}`, {
        owner: 'HUMAN',
        staffId,
        seizedAt: String(Date.now()),
        epoch: '5',
        is_handoff_locked: '1',
      });

      const { pipeline, mic } = createPipeline({ MIC_RETURN_BY_MENTION_ENABLED: true });

      const returnMsg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'chat_777',
        channelMsgId: 'msg_staff_005',
        sender: {
          role: 'STAFF_CS',
          channelUserId: staffId,
          name: '客服陈经理',
        },
        mentions: ['BOT'],
        type: 'text',
        text: '@机器人 客诉已安抚完毕，你继续服务',
        sentAt: Date.now(),
      };

      await pipeline.onInbound(returnMsg);

      const micStatus = await mic.getMicStatus(convId);
      expect(micStatus.owner).toBe('BOT');
      expect(micStatus.isHandoffLocked).toBe(false);
      expect(mockChannelAdapter.send).toHaveBeenCalledTimes(1);
    });
  });

  describe('5. 客户 @机器人 身份隔离', () => {
    it('客户发言 @机器人 正常进入聚合缓冲池，绝不触发人工交还流程', async () => {
      const { pipeline, mic } = createPipeline({ MIC_RETURN_BY_MENTION_ENABLED: true });
      const returnSpy = jest.spyOn(mic, 'returnByMention');

      const customerMsg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'chat_777',
        channelMsgId: 'msg_cust_001',
        sender: {
          role: 'CUSTOMER',
          channelUserId: customerId,
          name: '车主王先生',
        },
        mentions: ['BOT'],
        type: 'text',
        text: '@机器人 帮我查下明天的保养预约',
        sentAt: Date.now(),
      };

      await pipeline.onInbound(customerMsg);

      // 客户 @机器人 不触发人工话筒交还
      expect(returnSpy).not.toHaveBeenCalled();
      // 正常进入客户消息缓冲池
      expect(mockBufferService.push).toHaveBeenCalled();
    });
  });
});
