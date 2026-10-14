/**
 * @file s1-s3-buffer-tests.spec.ts
 * @description Task 5.2: 基础缓冲与封组用例自动化测试 (附录 C 用例 S1, S2, S3)
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §5.3、§7.1、§7.3、§7.4、附录 C (S1, S2, S3)
 */

import { TestInjectSuite } from './test-inject-suite';
import { InboundPipelineService } from '../../src/modules/pipeline/inbound-pipeline.service';
import { BufferService } from '../../src/modules/pipeline/buffer.service';
import { TimerService } from '../../src/modules/pipeline/timer.service';
import { SealerService } from '../../src/modules/pipeline/sealer.service';
import { MicrophoneService } from '../../src/modules/pipeline/microphone.service';
import { MysqlService } from '../../src/database/mysql.service';
import { RedisService } from '../../src/infra/redis/redis.service';
import { StateTransitionService } from '../../src/modules/pipeline/state-transition.service';
import type { Env } from '../../src/config/env';
import type { ChannelAdapter, InboundMessage, OutboundMessage } from '../../src/contracts';

describe('Task 5.2: 基础缓冲与封组用例自动化回归 (S1, S2, S3)', () => {
  let suite: TestInjectSuite;
  let inboundService: InboundPipelineService;
  let bufferService: BufferService;
  let timerService: TimerService;
  let sealerService: SealerService;
  let micService: MicrophoneService;

  let mockEnv: Env;
  let mockMysqlService: MysqlService;
  let mockRedisService: RedisService;
  let mockQueueService: any;
  let mockChannelAdapter: ChannelAdapter;
  let mockStateTransitionService: StateTransitionService;
  let mockCustomerContextService: any;

  // 内存状态模拟
  let dbMessages: Map<number, any>;
  let dbConversations: Map<number, any>;
  let dbGroups: Map<number, any>;
  let dbTurns: Map<number, any>;
  let dbQueries: Array<{ sql: string; params: any[] }>;
  let redisStore: Map<string, any>;
  let scheduledTimerJobs: Array<{ type: string; jobId: string; delay: number; data: any }>;
  let outboundReplies: OutboundMessage[];
  let stateTransitions: Array<{ entityType: string; entityId: number; from: string; to: string; reason?: string }>;

  const tenantId = 1;
  const chatId = 'wr_test_chat_s123';
  const customerId = 'wm_cust_wang';

  beforeEach(() => {
    dbMessages = new Map();
    dbConversations = new Map();
    dbGroups = new Map();
    dbTurns = new Map();
    dbQueries = [];
    redisStore = new Map();
    scheduledTimerJobs = [];
    outboundReplies = [];
    stateTransitions = [];

    mockEnv = {
      PORT: 3002,
      MYSQL_URL: 'mysql://mock',
      WECOM_BOT_ENABLED: true,
      WECOM_BOT_ID: 'bot_ai_01',
      WECOM_STAFF_MENTIONS: '@客服',
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: 6379,
      REDIS_DB: 0,
      CRM_BASE_URL: 'http://mock-crm',
      CRM_SERVICE_TOKEN: 'mock_token',
      CRM_TIMEOUT_MS: 800,
      QUIET_WINDOW_MS: 3000,
      HARD_TIMEOUT_MS: 15000,
      GROUP_MAX_MESSAGES: 5,
      MIC_SEIZE_SCOPE: 'ALL_INTERNAL',
      MIC_RETURN_BY_MENTION_ENABLED: true,
      HUMAN_WAIT_TIMEOUT_MS: 60000,
    };

    // 1. Mock MySQL
    let autoMsgId = 1000;
    let autoConvId = 2000;
    let autoGroupId = 3000;
    let autoTurnId = 4000;

    mockMysqlService = {
      getPool: () => ({
        query: async (sql: string, params: any[] = []) => {
          dbQueries.push({ sql, params });

          // 插入 message
          if (sql.includes('INSERT INTO message')) {
            autoMsgId++;
            const msgRec = {
              id: autoMsgId,
              tenant_id: params[0],
              conversation_id: 0,
              channel: params[1],
              channel_msg_id: params[2],
              sender_role: params[3],
              sender_channel_user_id: params[4],
              sender_name: params[5],
              msg_type: params[6],
              content: params[7],
              media_url: params[8],
              sent_at: params[9],
            };
            dbMessages.set(autoMsgId, msgRec);
            return [{ insertId: autoMsgId }];
          }

          // 更新 message conversation_id
          if (sql.includes('UPDATE message SET conversation_id = ?')) {
            const msg = dbMessages.get(params[1]);
            if (msg) msg.conversation_id = params[0];
            return [{ affectedRows: 1 }];
          }

          // 查询活跃会话
          if (sql.includes('FROM conversation') && sql.includes('channel_chat_id = ?')) {
            const rows = Array.from(dbConversations.values()).filter(
              (c) => c.tenant_id === params[0] && c.channel_chat_id === params[1] && c.status === 'ACTIVE',
            );
            return [rows];
          }

          // 查询会话详情
          if (sql.includes('FROM conversation') && sql.includes('WHERE id = ?')) {
            const conv = dbConversations.get(Number(params[0]));
            return [conv ? [conv] : []];
          }

          // 更新会话
          if (sql.includes('UPDATE conversation SET')) {
            return [{ affectedRows: 1 }];
          }

          // 更新消息 group_id
          if (sql.includes('UPDATE message SET group_id = ?')) {
            return [{ affectedRows: 1 }];
          }

          // 创建会话
          if (sql.includes('INSERT INTO conversation')) {
            autoConvId++;
            const conv = {
              id: autoConvId,
              tenant_id: params[0],
              channel: params[1],
              channel_chat_id: params[2],
              chat_name: params[3],
              status: 'ACTIVE',
              turn_count: 0,
              rule_pack_version: 'v1.0.0',
              created_at: new Date(),
            };
            dbConversations.set(autoConvId, conv);
            return [{ insertId: autoConvId }];
          }

          // 插入 msg_group
          if (sql.includes('INSERT INTO msg_group')) {
            autoGroupId++;
            const group = {
              id: autoGroupId,
              tenant_id: params[0],
              conversation_id: params[1],
              sender_channel_user_id: params[2],
              status: 'UNDERSTANDING',
              text: params[3] || '',
              merged_text: params[3] || '',
              message_count: params[4] || 0,
              seal_reason: params[5],
            };
            dbGroups.set(autoGroupId, group);
            return [{ insertId: autoGroupId }];
          }

          // 更新 msg_group
          if (sql.includes('UPDATE msg_group SET')) {
            return [{ affectedRows: 1 }];
          }

          // 查询单条 msg_group
          if (sql.includes('FROM msg_group WHERE id = ?')) {
            const g = dbGroups.get(Number(params[0]));
            return [g ? [g] : []];
          }

          // 插入/更新 turn
          if (sql.includes('INSERT INTO turn')) {
            autoTurnId++;
            const turn = {
              id: autoTurnId,
              tenant_id: params[0],
              conversation_id: params[1],
              group_id: params[2],
              status: 'IN_PROGRESS',
              reply_status: 'PENDING',
            };
            dbTurns.set(autoTurnId, turn);
            return [{ insertId: autoTurnId }];
          }

          if (sql.includes('FROM turn WHERE id = ?')) {
            const t = dbTurns.get(Number(params[0]));
            return [t ? [t] : []];
          }

          // 查询待封组消息 (WHERE id IN (...))
          if (sql.includes('FROM message') && sql.includes('WHERE id IN')) {
            const idList = params.map(Number);
            const rows = Array.from(dbMessages.values()).filter((m) => idList.includes(m.id));
            rows.sort((a, b) => new Date(a.sent_at).getTime() - new Date(b.sent_at).getTime());
            return [rows];
          }

          return [[]];
        },
      }),
    } as unknown as MysqlService;

    // 2. Mock Redis
    mockRedisService = {
      getClient: () => ({
        get: async (key: string) => redisStore.get(key) || null,
        set: async (key: string, val: string) => {
          redisStore.set(key, val);
          return 'OK';
        },
        del: async (key: string) => {
          redisStore.delete(key);
          return 1;
        },
        hget: async (key: string, field: string) => {
          const map = redisStore.get(key) || {};
          return map[field] !== undefined ? String(map[field]) : null;
        },
        hgetall: async (key: string) => {
          return redisStore.get(key) || {};
        },
        hset: async (key: string, fieldOrObj: any, val?: any) => {
          const map = redisStore.get(key) || {};
          if (typeof fieldOrObj === 'object') {
            Object.assign(map, fieldOrObj);
          } else {
            map[fieldOrObj] = val;
          }
          redisStore.set(key, map);
          return 1;
        },
        rpush: async (key: string, val: string) => {
          const list = redisStore.get(key) || [];
          list.push(val);
          redisStore.set(key, list);
          return list.length;
        },
        lrange: async (key: string, start: number, stop: number) => {
          const list = redisStore.get(key) || [];
          if (stop === -1) return list.slice(start);
          return list.slice(start, stop + 1);
        },
        lrem: async (key: string, count: number, value: string) => {
          let list = redisStore.get(key) || [];
          list = list.filter((item: string) => item !== value);
          redisStore.set(key, list);
          return 1;
        },
        keys: async (pattern: string) => {
          const prefix = pattern.replace('*', '');
          return Array.from(redisStore.keys()).filter((k) => k.startsWith(prefix));
        },
        eval: async (script: string, numkeys: number, ...args: any[]) => {
          if (script.includes('rpush')) {
            const bufKey = args[0];
            const metaKey = args[1];
            const msgId = args[2];
            const sentAtMs = args[3];

            const list = redisStore.get(bufKey) || [];
            list.push(msgId);
            redisStore.set(bufKey, list);

            const meta = redisStore.get(metaKey) || { count: 0, version: 0, epoch: 1 };
            meta.count = (meta.count || 0) + 1;
            meta.version = (meta.version || 0) + 1;
            meta.lastAt = sentAtMs;

            let isFirst = 0;
            if (meta.count === 1) {
              isFirst = 1;
              meta.firstAt = sentAtMs;
              meta.epoch = meta.epoch || 1;
            }

            redisStore.set(metaKey, meta);
            return [meta.count, meta.version, meta.epoch, meta.firstAt || sentAtMs, isFirst];
          }

          if (script.includes('lrange')) {
            const bufKey = args[0];
            const metaKey = args[1];
            const list = redisStore.get(bufKey) || [];
            redisStore.set(bufKey, []);
            const meta = redisStore.get(metaKey) || {};
            meta.count = 0;
            meta.epoch = (meta.epoch || 1) + 1;
            redisStore.set(metaKey, meta);
            return list;
          }

          return [];
        },
      }),
      acquireLock: jest.fn().mockResolvedValue({
        release: jest.fn().mockResolvedValue(true),
        unlock: jest.fn().mockResolvedValue(true),
      }),
    } as unknown as RedisService;

    // 3. Mock BullMQ QueueService
    mockQueueService = {
      getQueue: jest.fn().mockReturnValue({
        add: jest.fn().mockImplementation(async (name: string, data: any, opts: any) => {
          const job = { type: name, jobId: opts?.jobId || name, delay: opts?.delay || 0, data };
          scheduledTimerJobs.push(job);
          return job;
        }),
      }),
    };

    // 4. Mock ChannelAdapter
    mockChannelAdapter = {
      send: jest.fn().mockImplementation(async (msg: OutboundMessage) => {
        outboundReplies.push(msg);
      }),
    };

    // 5. Mock StateTransitionService
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
    } as unknown as StateTransitionService;

    // 6. Mock CustomerContextService
    mockCustomerContextService = {
      assembleCustomerProfile: jest.fn().mockResolvedValue({
        name: '王先生',
        phoneMasked: '138****0000',
        vehicle: '问界M7',
        product: '整车延保',
        bought: false,
      }),
    };

    // 组装业务 Service
    bufferService = new BufferService(mockRedisService, mockMysqlService);
    timerService = new TimerService(mockEnv, mockQueueService, bufferService);
    sealerService = new SealerService(
      mockEnv,
      mockRedisService,
      mockQueueService,
      mockMysqlService,
      bufferService,
      timerService,
      mockCustomerContextService,
    );
    timerService.setSealer(sealerService);

    micService = new MicrophoneService(mockEnv, mockMysqlService, mockRedisService);

    inboundService = new InboundPipelineService(
      mockEnv,
      mockMysqlService,
      mockRedisService,
      bufferService,
      timerService,
      sealerService,
      micService,
      mockStateTransitionService,
      mockChannelAdapter,
    );

    // 组装测试注入套件
    suite = new TestInjectSuite(
      inboundService,
      mockMysqlService,
      mockRedisService,
      micService,
      bufferService,
    );
  });

  describe('1. 用例 S1: 首条 0.5s 占位应答与会话初始化', () => {
    it('新客户首发消息：自动初始化 ACTIVE 会话，预约 3s 静默与 15s 硬熔断，轮次状态维持在途', async () => {
      const res = await suite.injectMessage({
        chatId,
        senderId: customerId,
        role: 'CUSTOMER',
        text: '你好，请问问界M7延保多少钱？',
      });

      expect(res.status).toBe('PROCESSED');
      expect(res.sealedDirectly).toBe(false);

      // 验证创建了活跃会话
      const conv = Array.from(dbConversations.values())[0];
      expect(conv).toBeDefined();
      expect(conv.channel_chat_id).toBe(chatId);
      expect(conv.status).toBe('ACTIVE');

      // 验证首条入池消息触发了 3s 静默与 15s 硬熔断任务预约
      const quietJob = scheduledTimerJobs.find((j) => j.type === 'quiet');
      const hardJob = scheduledTimerJobs.find((j) => j.type === 'hard');
      expect(quietJob).toBeDefined();
      expect(quietJob?.delay).toBe(3000);
      expect(hardJob).toBeDefined();
      expect(hardJob?.delay).toBe(15000);

      // 验证缓冲池中当前积累 1 条消息，版本号为 1，批次代号为 1
      const meta = await bufferService.getMeta(conv.id, customerId);
      expect(meta?.count).toBe(1);
      expect(meta?.version).toBe(1);
      expect(meta?.epoch).toBe(1);

      // 验证话筒所有权为 BOT 持有
      const micStatus = await micService.getMicStatus(conv.id);
      expect(micStatus.owner).toBe('BOT');
    });
  });

  describe('2. 用例 S2: 连发静默 3s 封组 (防抖与时序合并)', () => {
    it('客户在 1s 内连发 4 条消息，静默计时器连续推迟防抖，静默 3s 后准时触发 QUIET 封组', async () => {
      // 连续注入 4 条消息
      const injectResList = await suite.injectSequence([
        { chatId, senderId: customerId, role: 'CUSTOMER', text: '在吗' },
        { chatId, senderId: customerId, role: 'CUSTOMER', text: '我想咨询一下延保', delayMs: 20 },
        { chatId, senderId: customerId, role: 'CUSTOMER', text: '问界M7豪华版的', delayMs: 20 },
        { chatId, senderId: customerId, role: 'CUSTOMER', text: '价格多少钱一年', delayMs: 20 },
      ]);

      expect(injectResList.length).toBe(4);
      const conv = Array.from(dbConversations.values())[0];

      // 验证缓冲池累计 4 条消息，版本号自增到 4
      const meta = await bufferService.getMeta(conv.id, customerId);
      expect(meta?.count).toBe(4);
      expect(meta?.version).toBe(4);

      // 验证预约了 4 次 quiet 任务（对应 4 个连续递增的版本号）
      const quietJobs = scheduledTimerJobs.filter((j) => j.type === 'quiet');
      expect(quietJobs.length).toBe(4);
      expect(quietJobs[3].data.version).toBe(4);

      // 模拟前序版本（版本 1、2、3）延迟任务触发：因版本不匹配防抖丢弃
      await timerService.handleTimerJob({
        data: { type: 'quiet', convId: conv.id, senderId: customerId, version: 1 },
      } as any);
      await timerService.handleTimerJob({
        data: { type: 'quiet', convId: conv.id, senderId: customerId, version: 2 },
      } as any);
      await timerService.handleTimerJob({
        data: { type: 'quiet', convId: conv.id, senderId: customerId, version: 3 },
      } as any);

      // 验证此时均未触发封组
      expect(dbGroups.size).toBe(0);

      // 模拟最后一条消息后 3s 静默窗口到达（版本 4 触发）
      await timerService.handleTimerJob({
        data: { type: 'quiet', convId: conv.id, senderId: customerId, version: 4 },
      } as any);

      // 验证成功触发封组，生成 msg_group
      const group = Array.from(dbGroups.values())[0];
      expect(group).toBeDefined();
      expect(group.conversation_id).toBe(conv.id);
      expect(group.sender_channel_user_id).toBe(customerId);
      expect(group.message_count).toBe(4);
      // 验证按时间拼接合并文本
      expect(group.text).toBe('在吗，我想咨询一下延保，问界M7豪华版的，价格多少钱一年');

      expect(group.seal_reason).toBe('QUIET');
    });
  });

  describe('3. 用例 S3: 条数达到 5 条即刻封组 (COUNT)', () => {
    it('第 5 条消息入池瞬间立即触发封组，无需等待 3s 静默，seal_reason = COUNT', async () => {
      // 连续快速注入 5 条消息
      const injectResList = await suite.injectSequence([
        { chatId: 'chat_count_01', senderId: 'cust_002', text: '1. 延保咨询' },
        { chatId: 'chat_count_01', senderId: 'cust_002', text: '2. 问界M5' },
        { chatId: 'chat_count_01', senderId: 'cust_002', text: '3. 已经开了2年' },
        { chatId: 'chat_count_01', senderId: 'cust_002', text: '4. 里程3万公里' },
        { chatId: 'chat_count_01', senderId: 'cust_002', text: '5. 还能购买延保吗' },
      ]);

      expect(injectResList.length).toBe(5);
      // 前 4 条均未即刻封组
      expect(injectResList[0].sealedDirectly).toBe(false);
      expect(injectResList[1].sealedDirectly).toBe(false);
      expect(injectResList[2].sealedDirectly).toBe(false);
      expect(injectResList[3].sealedDirectly).toBe(false);

      // 第 5 条到达瞬间直接触发立即封组
      expect(injectResList[4].sealedDirectly).toBe(true);

      // 验证生成了对应的 msg_group，原因记录为 COUNT
      const countGroup = Array.from(dbGroups.values()).find(
        (g) => g.sender_channel_user_id === 'cust_002',
      );
      expect(countGroup).toBeDefined();
      expect(countGroup?.message_count).toBe(5);
      expect(countGroup?.seal_reason).toBe('COUNT');
    });
  });

  describe('4. 用例 S3: 首条起算 15s 硬超时熔断封组 (HARD)', () => {
    it('客户持续慢速发言不断推迟静默，15s 硬超时到期强制封组，seal_reason = HARD', async () => {
      // 慢速发送 3 条消息（持续推迟静默窗口）
      await suite.injectMessage({ chatId: 'chat_hard_01', senderId: 'cust_003', text: '第一条咨询' });
      await suite.injectMessage({ chatId: 'chat_hard_01', senderId: 'cust_003', text: '第二条追加' });
      await suite.injectMessage({ chatId: 'chat_hard_01', senderId: 'cust_003', text: '第三条补充' });

      const conv = Array.from(dbConversations.values()).find(
        (c) => c.channel_chat_id === 'chat_hard_01',
      );
      expect(conv).toBeDefined();

      const meta = await bufferService.getMeta(conv.id, 'cust_003');
      expect(meta?.count).toBe(3);
      expect(meta?.epoch).toBe(1);

      // 模拟首条起算 15s 硬超时任务触发 (epoch = 1)
      await timerService.handleTimerJob({
        data: {
          type: 'hard',
          convId: conv.id,
          senderId: 'cust_003',
          epoch: 1,
        },
      } as any);

      // 验证即使未静默满 3s 且未达 5 条，硬超时依然强制完成封组
      const hardGroup = Array.from(dbGroups.values()).find(
        (g) => g.sender_channel_user_id === 'cust_003',
      );
      expect(hardGroup).toBeDefined();
      expect(hardGroup?.message_count).toBe(3);
      expect(hardGroup?.seal_reason).toBe('HARD');
    });
  });
});
