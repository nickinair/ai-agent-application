/**
 * @file human-reply-archived.spec.ts
 * @description 人工抢跑与客户未处理缓冲消息就地归档 (ARCHIVED) 专属单测 (Task 3.4 & 附录 C 用例 S8)
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §5.9、§6.2、附录 C 用例 S8
 */

import { InboundPipelineService } from '../src/modules/pipeline/inbound-pipeline.service';
import { MicrophoneService } from '../src/modules/pipeline/microphone.service';
import { TimerService } from '../src/modules/pipeline/timer.service';
import type { InboundMessage } from '../src/contracts';
import type { Env } from '../src/config/env';

describe('人工抢跑与未处理缓冲消息归档测试 (Task 3.4 & 附录 C 用例 S8)', () => {
  let inboundService: InboundPipelineService;
  let micService: MicrophoneService;
  let timerService: TimerService;

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
        if (sql.includes('SELECT turn_count, rule_pack_version FROM conversation')) {
          return [[{ turn_count: 2, rule_pack_version: 'v1.2.0' }]];
        }
        if (sql.includes('INSERT INTO message')) return [{ insertId: 9001 }];
        if (sql.includes('INSERT INTO conversation')) return [{ insertId: 888 }];
        if (sql.includes('INSERT INTO msg_group')) return [{ insertId: 7008 }];
        if (sql.includes('INSERT INTO turn')) return [{ insertId: 6008 }];
        if (sql.includes('SELECT content, sent_at FROM message')) {
          return [
            [
              { content: '延保多少钱？', sent_at: new Date('2026-10-14T08:00:00Z') },
              { content: '保修范围包含哪些部位？', sent_at: new Date('2026-10-14T08:00:05Z') },
            ],
          ];
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
    jest.spyOn(micService, 'seizeByStaff').mockResolvedValue({
      changed: true,
      prevOwner: 'BOT',
      owner: 'HUMAN',
      epoch: 2,
      staffId: 'staff_007',
      reason: 'STAFF_SEIZED',
    });

    inboundService = new InboundPipelineService(
      baseEnv,
      mockMysqlService,
      mockRedisService,
      mockBufferService,
      timerService,
      mockSealerService,
      micService,
    );
  });

  describe('1. 核心用例 S8 验收: 客服发言抢跑，清空客户缓冲池并封组归档为 ARCHIVED', () => {
    it('【S8 验收】客户发送 2 条消息在缓冲池中，客服直接在群内回复，缓冲消息被清空并就地封组为 ARCHIVED (seal_reason=HUMAN_REPLIED)', async () => {
      // 模拟缓冲池中有客户 wm_cust_001 的滞留消息
      mockBufferService.nonEmptySenders.mockResolvedValue(['wm_cust_001']);
      mockBufferService.drain.mockResolvedValue([101, 102]);

      const staffMsg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'chat_group_vip',
        channelMsgId: 'msg_staff_reply_001',
        sender: { role: 'STAFF_CS', channelUserId: 'staff_007', name: '客服小张' },
        mentions: [],
        type: 'text',
        text: '车主您好，三年延保为 3999 元，覆盖发动机核心部件！',
        sentAt: Date.now(),
      };

      const res = await inboundService.onInbound(staffMsg);

      expect(res.status).toBe('STAFF_HANDLED');

      // 1. 验证缓冲池被 drain 清空
      expect(mockBufferService.drain).toHaveBeenCalledWith(888, 'wm_cust_001');

      // 2. 验证生成 msg_group 且状态为 ARCHIVED，原因 HUMAN_REPLIED
      const groupInsert = dbQueries.find(
        (q) => q.sql.includes('INSERT INTO msg_group') && q.sql.includes('ARCHIVED'),
      );
      expect(groupInsert).toBeDefined();
      expect(groupInsert?.sql).toContain("'ARCHIVED'");
      expect(groupInsert?.sql).toContain("'HUMAN_REPLIED'");
      expect(groupInsert?.params).toContain(2); // message_count = 2
      expect(groupInsert?.params).toContain('延保多少钱？\n保修范围包含哪些部位？'); // merged_text

      // 3. 验证 message 表的 group_id 被更新为 7008
      const messageUpdate = dbQueries.find(
        (q) => q.sql.includes('UPDATE message SET group_id') && q.params?.[0] === 7008,
      );
      expect(messageUpdate).toBeDefined();
      expect(messageUpdate?.params?.[1]).toEqual([101, 102]);
    });
  });

  describe('2. 人工交互轮次 (turn) 落地与话筒协同', () => {
    it('人工解答归档时，应生成对应的 turn 记录，标记 responder=HUMAN，关联 turn_id 并递增 conversation.turn_count', async () => {
      mockBufferService.nonEmptySenders.mockResolvedValue(['wm_cust_001']);
      mockBufferService.drain.mockResolvedValue([101, 102]);

      const staffMsg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'chat_group_vip',
        channelMsgId: 'msg_staff_reply_002',
        sender: { role: 'STAFF_CS', channelUserId: 'staff_007', name: '客服小张' },
        mentions: [],
        type: 'text',
        text: '稍后让客户经理私信发送合同明细。',
        sentAt: Date.now(),
      };

      await inboundService.onInbound(staffMsg);

      // 1. 验证 turn 插入参数：seq 为 3 (已有 2 轮 + 1)，responder 为 HUMAN，状态 DONE，reply_status SENT
      const turnInsert = dbQueries.find((q) => q.sql.includes('INSERT INTO turn'));
      expect(turnInsert).toBeDefined();
      expect(turnInsert?.sql).toContain("'DONE'");
      expect(turnInsert?.sql).toContain("'HUMAN'");
      expect(turnInsert?.sql).toContain("'SENT'");
      expect(turnInsert?.params).toContain(3); // nextSeq = 2 + 1
      expect(turnInsert?.params).toContain('稍后让客户经理私信发送合同明细。');
      expect(turnInsert?.params).toContain('v1.2.0');

      // 2. 验证 msg_group 的 turn_id 被更新为 6008
      const groupTurnUpdate = dbQueries.find(
        (q) => q.sql.includes('UPDATE msg_group SET turn_id') && q.params?.[0] === 6008,
      );
      expect(groupTurnUpdate).toBeDefined();
      expect(groupTurnUpdate?.params?.[1]).toBe(7008);

      // 3. 验证 conversation.turn_count 递增
      const convCountUpdate = dbQueries.find((q) =>
        q.sql.includes('UPDATE conversation SET turn_count = turn_count + 1'),
      );
      expect(convCountUpdate).toBeDefined();
    });
  });

  describe('3. 上下文继承与会话笔记 (conversation_background)', () => {
    it('人工归档时应将本轮客户问询与员工答复异步写入/追加至 conversation_background', async () => {
      mockBufferService.nonEmptySenders.mockResolvedValue(['wm_cust_001']);
      mockBufferService.drain.mockResolvedValue([101, 102]);

      const staffMsg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'chat_group_vip',
        channelMsgId: 'msg_staff_reply_003',
        sender: { role: 'STAFF_CS', channelUserId: 'staff_007' },
        mentions: [],
        type: 'text',
        text: '保修范围覆盖整车核心动力总成。',
        sentAt: Date.now(),
      };

      await inboundService.onInbound(staffMsg);

      // 验证写入/追加 conversation_background
      const bgUpsert = dbQueries.find((q) =>
        q.sql.includes('INSERT INTO conversation_background'),
      );
      expect(bgUpsert).toBeDefined();
      expect(bgUpsert?.params).toContain('保修范围覆盖整车核心动力总成。');
      expect(bgUpsert?.params).toContain('延保多少钱？\n保修范围包含哪些部位？');
      expect(bgUpsert?.params).toContain('staff_007');
    });
  });

  describe('4. 缓冲池无滞留消息时的防重复归档', () => {
    it('当客户缓冲池为空时，员工发言仅抢话筒，不创建空的 ARCHIVED 组或人工轮次', async () => {
      mockBufferService.nonEmptySenders.mockResolvedValue([]);

      const staffMsg: InboundMessage = {
        tenantId: 1,
        channel: 'wecom_group',
        channelChatId: 'chat_group_vip',
        channelMsgId: 'msg_staff_alone',
        sender: { role: 'STAFF_CS', channelUserId: 'staff_007' },
        mentions: [],
        type: 'text',
        text: '大家好，欢迎新朋友入群！',
        sentAt: Date.now(),
      };

      const res = await inboundService.onInbound(staffMsg);

      expect(res.status).toBe('STAFF_HANDLED');

      // 不会触发 drain
      expect(mockBufferService.drain).not.toHaveBeenCalled();

      // 不会创建 ARCHIVED 组
      const groupInsert = dbQueries.find((q) => q.sql.includes('INSERT INTO msg_group'));
      expect(groupInsert).toBeUndefined();

      // 不会插入人工 turn
      const turnInsert = dbQueries.find((q) => q.sql.includes('INSERT INTO turn'));
      expect(turnInsert).toBeUndefined();
    });
  });
});
