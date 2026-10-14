/**
 * @file inflight-voided.spec.ts
 * @description 员工抢话筒时 AI 在途组生成作废 (VOIDED) 专属单元测试 (Task 3.3 & 附录 C 用例 S7)
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §6.1、§6.2、附录 C 用例 S7
 */

import { InboundPipelineService } from '../src/modules/pipeline/inbound-pipeline.service';
import { MicrophoneService } from '../src/modules/pipeline/microphone.service';
import { TimerService } from '../src/modules/pipeline/timer.service';
import { StateTransitionService } from '../src/modules/pipeline/state-transition.service';
import type { InboundMessage } from '../src/contracts';
import type { Env } from '../src/config/env';

describe('员工抢话筒在途组作废联动测试 (Task 3.3 & 附录 C 用例 S7)', () => {
  let inboundService: InboundPipelineService;
  let micService: MicrophoneService;
  let timerService: TimerService;
  let stateTransitionService: StateTransitionService;

  let mockMysqlService: any;
  let mockRedisService: any;
  let mockBufferService: any;
  let mockSealerService: any;

  let mockDbPool: any;
  let mockRedisClient: any;
  let dbQueries: { sql: string; params?: any[] }[] = [];

  let baseEnv: Env;

  beforeEach(() => {
    dbQueries = [];
    baseEnv = {
      PORT: 3002,
      MYSQL_URL: 'mysql://mock',
      WECOM_BOT_ENABLED: false,
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

    mockDbPool = {
      query: jest.fn().mockImplementation(async (sql: string, params?: any[]) => {
        dbQueries.push({ sql, params });
        if (sql.includes('SELECT id FROM conversation')) return [[{ id: 888 }]];
        if (sql.includes('INSERT INTO message')) return [{ insertId: 9001 }];
        if (sql.includes('INSERT INTO conversation')) return [{ insertId: 888 }];
        if (sql.includes('SELECT status, turn_id FROM msg_group') || sql.includes('SELECT status FROM msg_group')) {
          if (params?.[0] === '7002') {
            return [[{ status: 'FINAL_CHECKING', turn_id: 6002 }]];
          }
          if (params?.[0] === '7003_SENT') {
            return [[{ status: 'SENT', turn_id: 6003 }]];
          }
          return [[{ status: 'UNDERSTANDING', turn_id: 6001 }]];
        }
        if (sql.includes('UPDATE turn')) {
          return [{ affectedRows: 1 }];
        }
        return [{ affectedRows: 1 }];
      }),
    };

    mockMysqlService = {
      getPool: jest.fn().mockReturnValue(mockDbPool),
    };

    mockRedisClient = {
      get: jest.fn(),
      set: jest.fn().mockResolvedValue('OK'),
      hset: jest.fn().mockResolvedValue('OK'),
      hgetall: jest.fn().mockResolvedValue({}),
      eval: jest.fn(),
      del: jest.fn().mockResolvedValue(1),
      incr: jest.fn().mockResolvedValue(1),
    };

    mockRedisService = {
      getClient: jest.fn().mockReturnValue(mockRedisClient),
    };

    mockBufferService = {
      push: jest.fn(),
      drain: jest.fn().mockResolvedValue([]),
      nonEmptySenders: jest.fn().mockResolvedValue([]),
    };

    mockSealerService = {
      seal: jest.fn().mockResolvedValue({ success: true }),
    };

    timerService = {
      scheduleIdle: jest.fn().mockResolvedValue(undefined),
      scheduleQuiet: jest.fn().mockResolvedValue(undefined),
      scheduleHard: jest.fn().mockResolvedValue(undefined),
      scheduleHumanWait: jest.fn().mockResolvedValue(undefined),
      cancelHumanWait: jest.fn().mockResolvedValue(undefined),
    } as any;

    micService = new MicrophoneService(baseEnv, mockMysqlService, mockRedisService);
    // 默认 Lua 脚本返回抢占成功
    jest.spyOn(micService, 'seizeByStaff').mockResolvedValue({
      changed: true,
      prevOwner: 'BOT',
      owner: 'HUMAN',
      epoch: 2,
      staffId: 'staff_007',
      reason: 'STAFF_SEIZED',
    });

    stateTransitionService = {
      transition: jest.fn().mockResolvedValue({
        id: 1,
        entityType: 'GROUP',
        entityId: '7001',
        fromStatus: 'UNDERSTANDING',
        toStatus: 'VOIDED',
      }),
    } as any;

    inboundService = new InboundPipelineService(
      baseEnv,
      mockMysqlService,
      mockRedisService,
      mockBufferService,
      timerService,
      mockSealerService,
      micService,
      stateTransitionService,
    );
  });

  describe('1. 核心用例 S7 验收: UNDERSTANDING 阶段员工发言触发在途组作废', () => {
    it('【S7 验收】当组处于 UNDERSTANDING 时，员工在群内发言抢占话筒，应原子作废该组为 VOIDED 并更新轮次且清理互斥锁', async () => {
      // 模拟 Redis 中存在在途任务登记 (ag:inflight:888)
      mockRedisClient.hgetall.mockImplementation(async (key: string) => {
        if (key === 'ag:inflight:888') {
          return {
            groupId: '7001',
            convId: '888',
            turnId: '6001',
            sealedAt: String(Date.now() - 1000),
          };
        }
        if (key === 'ag:mic:888') {
          return { owner: 'BOT', epoch: '1' };
        }
        return {};
      });

      const staffMsg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'chat_group_vip',
        channelMsgId: 'msg_staff_seize_001',
        sender: { role: 'STAFF_CS', channelUserId: 'staff_007', name: '客服小张' },
        mentions: [],
        type: 'text',
        text: '车主您好，延保问题由我来为您解答！',
        sentAt: Date.now(),
      };

      const res = await inboundService.onInbound(staffMsg);

      // 1. 员工消息处理状态
      expect(res.status).toBe('STAFF_HANDLED');
      expect(res.conversationId).toBe(888);

      // 2. 验证话筒被成功抢占且取消 60s 接回
      expect(micService.seizeByStaff).toHaveBeenCalledWith(888, 'staff_007', 'STAFF_CS');
      expect(timerService.cancelHumanWait).toHaveBeenCalledWith(888, 2);

      // 3. 验证状态机驱动组从 UNDERSTANDING 原子跃迁至 VOIDED (S7 核心断言)
      expect(stateTransitionService.transition).toHaveBeenCalledWith(
        'GROUP',
        '7001',
        'UNDERSTANDING',
        'VOIDED',
        expect.objectContaining({
          tenantId: 1,
          operatorType: 'STAFF',
          reason: 'MIC_SEIZED',
          traceId: 'msg_staff_seize_001',
        }),
      );

      // 4. 验证轮次 turn 表记录被同步标记作废 (reply_status='VOIDED', status='DONE')
      const turnUpdateQuery = dbQueries.find(
        (q) => q.sql.includes('UPDATE turn') && q.sql.includes('VOIDED'),
      );
      expect(turnUpdateQuery).toBeDefined();
      expect(turnUpdateQuery?.params).toContain(6001);

      // 5. 验证清理在途记录与会话锁
      expect(mockRedisClient.del).toHaveBeenCalledWith('ag:inflight:888');
      expect(mockRedisClient.del).toHaveBeenCalledWith('ag:lock:conv:888');
    });
  });

  describe('2. S7 场景 2: FINAL_CHECKING (末检关卡) 阶段员工发言触发在途作废', () => {
    it('当组处于 FINAL_CHECKING 发送前门禁时，员工发言仍应原子作废该组为 VOIDED', async () => {
      mockRedisClient.hgetall.mockImplementation(async (key: string) => {
        if (key === 'ag:inflight:888') {
          return {
            groupId: '7002',
            convId: '888',
            turnId: '6002',
            sealedAt: String(Date.now() - 2500),
          };
        }
        return { owner: 'BOT', epoch: '1' };
      });

      const staffMsg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'chat_group_vip',
        channelMsgId: 'msg_staff_seize_002',
        sender: { role: 'STAFF_OTHER', channelUserId: 'sales_rep_01', name: '销售顾问李四' },
        mentions: [],
        type: 'text',
        text: '稍等，我查下您的保养套餐',
        sentAt: Date.now(),
      };

      const res = await inboundService.onInbound(staffMsg);

      expect(res.status).toBe('STAFF_HANDLED');

      // 验证 FINAL_CHECKING 跃迁至 VOIDED
      expect(stateTransitionService.transition).toHaveBeenCalledWith(
        'GROUP',
        '7002',
        'FINAL_CHECKING',
        'VOIDED',
        expect.objectContaining({
          tenantId: 1,
          operatorType: 'STAFF',
          reason: 'MIC_SEIZED',
        }),
      );

      // 验证 turn #6002 更新为 VOIDED
      const turnUpdateQuery = dbQueries.find(
        (q) => q.sql.includes('UPDATE turn') && q.params?.includes(6002),
      );
      expect(turnUpdateQuery).toBeDefined();

      // 验证在途 Redis 清理
      expect(mockRedisClient.del).toHaveBeenCalledWith('ag:inflight:888');
      expect(mockRedisClient.del).toHaveBeenCalledWith('ag:lock:conv:888');
    });
  });

  describe('3. 非在途或已完成状态防误作废', () => {
    it('当无在途任务记录时，员工发言正常抢占话筒，不调用作废跃迁', async () => {
      mockRedisClient.hgetall.mockImplementation(async (key: string) => {
        if (key === 'ag:inflight:888') {
          return {}; // 无在途
        }
        return { owner: 'BOT', epoch: '1' };
      });

      const staffMsg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'chat_group_vip',
        channelMsgId: 'msg_staff_normal_001',
        sender: { role: 'STAFF_CS', channelUserId: 'staff_007' },
        mentions: [],
        type: 'text',
        text: '大家下午好！',
        sentAt: Date.now(),
      };

      await inboundService.onInbound(staffMsg);

      // 不应调用作废
      expect(stateTransitionService.transition).not.toHaveBeenCalled();
    });

    it('当组已流转为 SENT 状态时，员工发言不作废已发送组', async () => {
      mockRedisClient.hgetall.mockImplementation(async (key: string) => {
        if (key === 'ag:inflight:888') {
          return { groupId: '7003_SENT', convId: '888', turnId: '6003' };
        }
        return { owner: 'BOT', epoch: '1' };
      });

      const staffMsg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'chat_group_vip',
        channelMsgId: 'msg_staff_sent_001',
        sender: { role: 'STAFF_CS', channelUserId: 'staff_007' },
        mentions: [],
        type: 'text',
        text: '我来跟进处理',
        sentAt: Date.now(),
      };

      await inboundService.onInbound(staffMsg);

      // 已是 SENT，不能跃迁为 VOIDED
      expect(stateTransitionService.transition).not.toHaveBeenCalled();
      // 但会释放残余锁
      expect(mockRedisClient.del).toHaveBeenCalledWith('ag:inflight:888');
      expect(mockRedisClient.del).toHaveBeenCalledWith('ag:lock:conv:888');
    });
  });

  describe('4. LLM 生成任务中断控制器 (AbortController) 机制验证', () => {
    it('当存在活跃的 AbortController 时，员工抢话筒应触发中断信号，节省 Token', async () => {
      mockRedisClient.hgetall.mockImplementation(async (key: string) => {
        if (key === 'ag:inflight:888') {
          return { groupId: '7001', convId: '888', turnId: '6001' };
        }
        return { owner: 'BOT', epoch: '1' };
      });

      // 注册在途 AbortController
      const controller = new AbortController();
      expect(controller.signal.aborted).toBe(false);

      inboundService.registerAbortController('7001', controller);

      const staffMsg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'chat_group_vip',
        channelMsgId: 'msg_staff_seize_abort',
        sender: { role: 'STAFF_CS', channelUserId: 'staff_007' },
        mentions: [],
        type: 'text',
        text: '这个由人工来接！',
        sentAt: Date.now(),
      };

      await inboundService.onInbound(staffMsg);

      // 断言 controller.signal.aborted 已经被置为 true
      expect(controller.signal.aborted).toBe(true);

      // 再次触发应返回 false (已注销清理)
      const secondAbort = inboundService.abortInflight('7001');
      expect(secondAbort).toBe(false);
    });

    it('手动注销 unregisterAbortController 后，不应触发该 controller', () => {
      const controller = new AbortController();
      inboundService.registerAbortController('9999', controller);
      inboundService.unregisterAbortController('9999');

      const aborted = inboundService.abortInflight('9999');
      expect(aborted).toBe(false);
      expect(controller.signal.aborted).toBe(false);
    });
  });
});
