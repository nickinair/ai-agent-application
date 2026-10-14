/**
 * @file s17-s23-isolation-tests.spec.ts
 * @description Task 5.4: 隔离、容灾与身份用例自动化端到端测试 (附录 C 用例 S17, S18, S19, S21, S23)
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §5.1、§5.2、§5.3、§6.1、§7.1、§16.2、附录 C (S17, S18, S19, S21, S23)
 */

import { TestInjectSuite } from './test-inject-suite';
import { InboundPipelineService } from '../../src/modules/pipeline/inbound-pipeline.service';
import { BufferService } from '../../src/modules/pipeline/buffer.service';
import { TimerService } from '../../src/modules/pipeline/timer.service';
import { SealerService } from '../../src/modules/pipeline/sealer.service';
import { MicrophoneService } from '../../src/modules/pipeline/microphone.service';
import { WatchdogService } from '../../src/modules/pipeline/watchdog.service';
import { StateTransitionService } from '../../src/modules/pipeline/state-transition.service';
import { FinalCheckService } from '../../src/modules/pipeline/final-check.service';
import { MetricsService } from '../../src/infra/metrics.service';
import { MysqlService } from '../../src/database/mysql.service';
import { RedisService } from '../../src/infra/redis/redis.service';
import type { Env } from '../../src/config/env';
import type { ChannelAdapter, OutboundMessage } from '../../src/contracts';

describe('Task 5.4: 隔离、容灾与身份用例自动化回归 (S17, S18, S19, S21, S23)', () => {
  let suite: TestInjectSuite;
  let inboundService: InboundPipelineService;
  let bufferService: BufferService;
  let timerService: TimerService;
  let sealerService: SealerService;
  let micService: MicrophoneService;
  let watchdogService: WatchdogService;
  let stateTransitionService: StateTransitionService;
  let finalCheckService: FinalCheckService;
  let metricsService: MetricsService;

  let mockEnv: Env;
  let mockMysqlService: MysqlService;
  let mockRedisService: RedisService;
  let mockQueueService: any;
  let mockChannelAdapter: ChannelAdapter;
  let mockCustomerContextService: any;

  // 内存状态
  let dbMessages: Map<number, any>;
  let dbConversations: Map<number, any>;
  let dbGroups: Map<number, any>;
  let dbTurns: Map<number, any>;
  let dbQueries: Array<{ sql: string; params: any[] }>;
  let redisStore: Map<string, any>;
  let scheduledTimerJobs: Array<{ type: string; jobId: string; delay: number; data: any }>;
  let outboundReplies: OutboundMessage[];

  const tenantId = 1;
  const chatId = 'wr_test_chat_isolation_s17_s23';

  beforeEach(() => {
    dbMessages = new Map();
    dbConversations = new Map();
    dbGroups = new Map();
    dbTurns = new Map();
    dbQueries = [];
    redisStore = new Map();
    scheduledTimerJobs = [];
    outboundReplies = [];

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

    let autoMsgId = 1000;
    let autoConvId = 2000;
    let autoGroupId = 3000;
    let autoTurnId = 4000;

    // 1. Mock MySQL
    mockMysqlService = {
      getPool: () => ({
        query: async (sql: string, params: any[] = []) => {
          dbQueries.push({ sql, params });

          // 插入 message 并做唯一键检查 (uk_channel_msg)
          if (sql.includes('INSERT INTO message')) {
            let channelMsgId = params[2];
            let senderRole = params[3] || 'CUSTOMER';
            let content = params[7] || '';
            let senderChannelUserId = params[4];

            if (sql.includes("'BOT'") && sql.includes("'bot'")) {
              // 来自 Watchdog 的降级消息
              channelMsgId = params[4];
              senderRole = 'BOT';
              senderChannelUserId = 'bot';
              content = params[5] || '';
            }

            const exists = Array.from(dbMessages.values()).some(
              (m) => m.channel_msg_id === channelMsgId,
            );
            if (exists) {
              const err: any = new Error(`Duplicate entry '${channelMsgId}' for key 'uk_channel_msg'`);
              err.code = 'ER_DUP_ENTRY';
              throw err;
            }

            autoMsgId++;
            const msgRec = {
              id: autoMsgId,
              tenant_id: params[0],
              conversation_id: params[1] || 0,
              channel: 'wecom',
              channel_msg_id: channelMsgId,
              sender_role: senderRole,
              sender_channel_user_id: senderChannelUserId,
              sender_name: params[5],
              msg_type: 'text',
              content,
              media_url: null,
              sent_at: new Date(),
            };
            dbMessages.set(autoMsgId, msgRec);
            return [{ insertId: autoMsgId }];
          }

          // 更新 message conversation_id
          if (sql.includes('UPDATE message SET conversation_id = ?')) {
            const msg = dbMessages.get(Number(params[1]));
            if (msg) msg.conversation_id = params[0];
            return [{ affectedRows: 1 }];
          }

          // 更新 message group_id
          if (sql.includes('UPDATE message SET group_id = ?')) {
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

          // 更新会话
          if (sql.includes('UPDATE conversation SET')) {
            return [{ affectedRows: 1 }];
          }

          // 插入 msg_group
          if (sql.includes('INSERT INTO msg_group')) {
            autoGroupId++;
            let status = 'UNDERSTANDING';
            let sealReason = params[5];
            let mergedText = params[3] || '';
            let messageCount = params[4] || 0;

            if (sql.includes("'ARCHIVED'")) {
              status = 'ARCHIVED';
              sealReason = 'HUMAN_REPLIED';
              messageCount = params[3] || 0;
              mergedText = params[4] || '';
            }

            const group = {
              id: autoGroupId,
              tenant_id: params[0],
              conversation_id: params[1],
              sender_channel_user_id: params[2],
              status,
              text: mergedText,
              merged_text: mergedText,
              message_count: messageCount,
              seal_reason: sealReason,
            };
            dbGroups.set(autoGroupId, group);
            return [{ insertId: autoGroupId }];
          }

          // 乐观锁状态跃迁 update msg_group
          if (sql.includes('UPDATE msg_group SET status = ?')) {
            const newStatus = params[0];
            const gId = Number(params[1]);
            const g = dbGroups.get(gId);
            if (g) g.status = newStatus;
            return [{ affectedRows: 1 }];
          }

          // 查询单条 msg_group
          if (sql.includes('FROM msg_group WHERE id = ?')) {
            const g = dbGroups.get(Number(params[0]));
            return [g ? [g] : []];
          }

          // 查询在途组
          if (
            sql.includes('FROM msg_group') &&
            sql.includes(
              "status IN ('BUFFERING', 'COLLECTING', 'UNDERSTANDING', 'REASONING', 'GENERATING', 'FINAL_CHECKING')",
            )
          ) {
            const convId = params[0];
            const rows = Array.from(dbGroups.values()).filter(
              (g) =>
                g.conversation_id === convId &&
                !['DONE', 'VOIDED', 'ARCHIVED', 'SENT', 'FAILED'].includes(g.status),
            );
            return [rows];
          }

          // 插入 turn
          if (sql.includes('INSERT INTO turn')) {
            autoTurnId++;
            let status = 'IN_PROGRESS';
            let replyStatus = 'PENDING';
            let replyText = '';
            let groupId = params[2];

            if (sql.includes("'DONE'") && sql.includes("'HUMAN'")) {
              status = 'DONE';
              replyStatus = 'SENT';
              replyText = params[3] || '';
              groupId = 0;
            }

            const turn = {
              id: autoTurnId,
              tenant_id: params[0],
              conversation_id: params[1],
              group_id: groupId,
              status,
              reply_status: replyStatus,
              reply_text: replyText,
            };
            dbTurns.set(autoTurnId, turn);
            return [{ insertId: autoTurnId }];
          }

          // 更新 turn
          if (sql.includes('UPDATE turn SET reply_status = ?')) {
            const tId = Number(params[params.length - 1]);
            const turn = dbTurns.get(tId);
            if (turn) {
              turn.reply_status = params[0];
              turn.status = 'DONE';
            }
            return [{ affectedRows: 1 }];
          }

          // 查询消息 (WHERE id IN (...))
          if (sql.includes('FROM message') && sql.includes('WHERE id IN')) {
            const flat = Array.isArray(params[0]) ? params[0] : params;
            const idList = flat.map(Number);
            const rows = Array.from(dbMessages.values()).filter((m) => idList.includes(m.id));
            rows.sort((a, b) => new Date(a.sent_at).getTime() - new Date(b.sent_at).getTime());
            return [rows];
          }

          // 状态跃迁日志 insert
          if (sql.includes('INSERT INTO state_transition_log')) {
            return [{ insertId: 1 }];
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
        hgetall: async (key: string) => redisStore.get(key) || {},
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
        incr: async (key: string) => {
          const current = Number(redisStore.get(key) || 0) + 1;
          redisStore.set(key, String(current));
          return current;
        },
        llen: async (key: string) => {
          const list = redisStore.get(key) || [];
          return list.length;
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
          // 缓冲追加
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

          // 缓冲排空
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

          // 话筒员工抢占
          if (script.includes('currentStaff ~= ARGV[1]') || script.includes('STAFF_SEIZED')) {
            const micKey = args[0];
            const staffId = args[1];
            const nowMs = args[2];
            const reason = args[3];
            const current = redisStore.get(micKey) || { owner: 'BOT', staffId: '', epoch: '0' };
            const currentOwner = current.owner || 'BOT';
            const currentStaff = current.staffId || '';
            const currentEpoch = Number(current.epoch || 0);

            let changed = 0;
            let newEpoch = currentEpoch;
            if (currentOwner === 'BOT' || currentStaff !== staffId) {
              changed = 1;
              newEpoch = currentEpoch + 1;
              current.owner = 'HUMAN';
              current.staffId = staffId;
              current.since = String(nowMs);
              current.reason = reason;
              current.epoch = String(newEpoch);
            } else {
              current.since = String(nowMs);
            }
            redisStore.set(micKey, current);
            return [changed, currentOwner, 'HUMAN', newEpoch, staffId, reason];
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
        getJob: jest.fn().mockImplementation(async (jobId: string) => {
          const found = scheduledTimerJobs.find((j) => j.jobId === jobId);
          if (!found) return null;
          return {
            remove: jest.fn().mockResolvedValue(true),
          };
        }),
      }),
    };

    // 4. Mock ChannelAdapter
    mockChannelAdapter = {
      send: jest.fn().mockImplementation(async (msg: OutboundMessage) => {
        outboundReplies.push(msg);
      }),
    };

    // 5. CustomerContext
    mockCustomerContextService = {
      assembleCustomerProfile: jest.fn().mockResolvedValue({
        name: '车主赵先生',
        phoneMasked: '138****9999',
        vehicle: '问界M7',
        product: '整车延保',
        bought: false,
      }),
    };

    metricsService = new MetricsService();
    stateTransitionService = new StateTransitionService(mockMysqlService);
    bufferService = new BufferService(mockRedisService, mockMysqlService);
    micService = new MicrophoneService(mockEnv, mockMysqlService, mockRedisService);
    timerService = new TimerService(
      mockEnv,
      mockQueueService,
      bufferService,
      mockRedisService,
      mockMysqlService,
      stateTransitionService,
      micService,
    );
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

    watchdogService = new WatchdogService(
      mockEnv,
      mockMysqlService,
      mockRedisService,
      stateTransitionService,
      sealerService,
    );

    finalCheckService = new FinalCheckService(
      bufferService,
      stateTransitionService,
      micService,
      mockChannelAdapter,
      mockMysqlService,
      metricsService,
    );

    inboundService = new InboundPipelineService(
      mockEnv,
      mockMysqlService,
      mockRedisService,
      bufferService,
      timerService,
      sealerService,
      micService,
      stateTransitionService,
      mockChannelAdapter,
    );

    suite = new TestInjectSuite(
      inboundService,
      mockMysqlService,
      mockRedisService,
      micService,
      bufferService,
    );
  });

  describe('1. 用例 S17: 群内车主与家属交替发言物理隔离分别成组', () => {
    it('车主与家属在同一群交替发言：按发送人物理隔离缓冲，各自独立防抖，分别成组处理', async () => {
      const ownerId = 'cust_owner_zhao';
      const familyId = 'cust_family_qian';

      // 1. 车主发言：“延保怎么买？”
      const res1 = await suite.injectMessage({
        chatId: 'chat_s17',
        senderId: ownerId,
        text: '延保怎么买？',
      });
      expect(res1.status).toBe('PROCESSED');

      // 2. 家属发言：“包含电池质保吗？”
      const res2 = await suite.injectMessage({
        chatId: 'chat_s17',
        senderId: familyId,
        text: '包含电池质保吗？',
      });
      expect(res2.status).toBe('PROCESSED');

      // 3. 车主追问：“要多少钱一年”
      const res3 = await suite.injectMessage({
        chatId: 'chat_s17',
        senderId: ownerId,
        text: '要多少钱一年？',
      });
      expect(res3.status).toBe('PROCESSED');

      const conv = Array.from(dbConversations.values()).find((c) => c.channel_chat_id === 'chat_s17');
      expect(conv).toBeDefined();

      // 验证缓冲池物理隔离：车主 2 条，家属 1 条
      const ownerBuf = await bufferService.peekSince(conv.id, 0, ownerId);
      expect(ownerBuf.length).toBe(2);

      const familyBuf = await bufferService.peekSince(conv.id, 0, familyId);
      expect(familyBuf.length).toBe(1);

      // 验证各自有独立的静默防抖延迟任务
      const ownerQuietJobs = scheduledTimerJobs.filter(
        (j) => j.type === 'quiet' && j.data?.senderId === ownerId,
      );
      const familyQuietJobs = scheduledTimerJobs.filter(
        (j) => j.type === 'quiet' && j.data?.senderId === familyId,
      );
      expect(ownerQuietJobs.length).toBeGreaterThanOrEqual(1);
      expect(familyQuietJobs.length).toBe(1);

      // 模拟车主静默 3s 到期封组
      await sealerService.seal(conv.id, ownerId, 'QUIET');

      // 模拟家属静默 3s 到期封组
      await sealerService.seal(conv.id, familyId, 'QUIET');

      // 验证生成了两个独立的 msg_group 记录
      const ownerGroup = Array.from(dbGroups.values()).find(
        (g) => g.conversation_id === conv.id && g.sender_channel_user_id === ownerId,
      );
      const familyGroup = Array.from(dbGroups.values()).find(
        (g) => g.conversation_id === conv.id && g.sender_channel_user_id === familyId,
      );

      expect(ownerGroup).toBeDefined();
      expect(ownerGroup?.message_count).toBe(2);
      expect(ownerGroup?.text).toContain('延保怎么买？');
      expect(ownerGroup?.text).toContain('要多少钱一年？');

      expect(familyGroup).toBeDefined();
      expect(familyGroup?.message_count).toBe(1);
      expect(familyGroup?.text).toBe('包含电池质保吗？');
    });
  });

  describe('2. 用例 S18: Worker 节点在途崩溃，看门狗 8s 超时自愈与降级', () => {
    it('组在 UNDERSTANDING 期间 Worker 崩溃滞留超 8s：看门狗发现超时，解开会话锁，置组为 SENT 并下发降级话术', async () => {
      // 1. 初始化会话与在途组
      await suite.injectMessage({ chatId: 'chat_s18', senderId: 'cust_s18', text: '在吗，系统有响应吗？' });
      const conv = Array.from(dbConversations.values()).find((c) => c.channel_chat_id === 'chat_s18');
      expect(conv).toBeDefined();

      const stuckGroupId = 3888;
      const stuckGroup = {
        id: stuckGroupId,
        tenant_id: tenantId,
        conversation_id: conv.id,
        sender_channel_user_id: 'cust_s18',
        status: 'UNDERSTANDING',
      };
      dbGroups.set(stuckGroupId, stuckGroup);

      // 模拟获取排他锁与在途记录
      const now = Date.now();
      const client = mockRedisService.getClient();
      await client.set(`ag:lock:conv:${conv.id}`, 'locked');
      await client.hset(`ag:inflight:${conv.id}`, {
        groupId: String(stuckGroupId),
        turnId: '4888',
        sealedAt: String(now - 9000), // 已停滞 9 秒（超时阈值为 8000ms）
      });

      // 2. 触发看门狗扫描与自愈
      watchdogService.setTimeoutMs(8000);
      const report = await watchdogService.scanAndRecover(now);

      // 验证扫描到并自愈了 1 个卡死组
      expect(report.scanned).toBe(1);
      expect(report.recovered).toBe(1);

      // 验证会话锁已被释放解死锁
      const lockVal = await client.get(`ag:lock:conv:${conv.id}`);
      expect(lockVal).toBeNull();

      // 验证在途键已被清理
      const inflightVal = await client.hgetall(`ag:inflight:${conv.id}`);
      expect(Object.keys(inflightVal).length).toBe(0);

      // 验证组状态流转为 SENT (降级状态)
      expect(stuckGroup.status).toBe('SENT');

      // 验证向 message 表写入了友好降级回复
      const fallbackMsg = Array.from(dbMessages.values()).find(
        (m) => m.conversation_id === conv.id && m.content === '网络繁忙，稍后为您服务',
      );
      expect(fallbackMsg).toBeDefined();
      expect(fallbackMsg?.sender_role).toBe('BOT');
    });
  });

  describe('3. 用例 S19: 渠道网络重复投递同一条消息，依据唯一索引安全幂等去重', () => {
    it('同一 channel_msg_id 重复推接入站：首条落库缓冲，次条触发唯一索引拦截安全忽略，不产生重复组', async () => {
      const channelMsgId = 'wx_msg_duplicate_9999';

      // 1. 首次投递
      const firstRes = await suite.injectMessage({
        chatId: 'chat_s19',
        senderId: 'cust_s19',
        channelMsgId: channelMsgId,
        text: '重复消息测试：我想买延保',
      });
      expect(firstRes.status).toBe('PROCESSED');
      expect(firstRes.messageId).toBeDefined();

      const conv = Array.from(dbConversations.values()).find((c) => c.channel_chat_id === 'chat_s19');
      expect(conv).toBeDefined();

      // 验证缓冲池中有 1 条消息
      expect((await bufferService.peekSince(conv.id, 0)).length).toBe(1);

      // 2. 网络抖动导致渠道重试投递完全相同的 channel_msg_id
      const secondRes = await suite.injectMessage({
        chatId: 'chat_s19',
        senderId: 'cust_s19',
        channelMsgId: channelMsgId,
        text: '重复消息测试：我想买延保',
      });

      // 验证被拦截并返回 IGNORED_DUPLICATE
      expect(secondRes.status).toBe('IGNORED_DUPLICATE');

      // 验证数据库 message 表没有生成第二条相同消息
      const matchingMsgs = Array.from(dbMessages.values()).filter(
        (m) => m.channel_msg_id === channelMsgId,
      );
      expect(matchingMsgs.length).toBe(1);

      // 验证缓冲池仍旧只有 1 条消息，未被污染重复入池
      expect((await bufferService.peekSince(conv.id, 0)).length).toBe(1);
    });
  });

  describe('4. 用例 S21: 群内销售（非客服内部员工）发言与 MIC_SEIZE_SCOPE 控制', () => {
    it('场景 A: MIC_SEIZE_SCOPE = ALL_INTERNAL 时，销售人员发言触发抢占话筒转为 HUMAN', async () => {
      mockEnv.MIC_SEIZE_SCOPE = 'ALL_INTERNAL';

      // 客户先发言建立会话
      await suite.injectMessage({ chatId: 'chat_s21_a', senderId: 'cust_s21', text: '多少钱能包牌？' });
      const conv = Array.from(dbConversations.values()).find((c) => c.channel_chat_id === 'chat_s21_a');
      expect(conv).toBeDefined();
      expect((await micService.getMicStatus(conv.id)).owner).toBe('BOT');

      // 销售人员（STAFF_OTHER）发言
      const staffRes = await suite.injectMessage({
        chatId: 'chat_s21_a',
        senderId: 'sales_rep_01',
        role: 'STAFF_OTHER',
        text: '包牌价格可以私聊我谈',
      });
      expect(staffRes.status).toBe('STAFF_HANDLED');

      // 验证话筒转为 HUMAN
      const micStatus = await micService.getMicStatus(conv.id);
      expect(micStatus.owner).toBe('HUMAN');
      expect(micStatus.staffId).toBe('sales_rep_01');
    });

    it('场景 B: MIC_SEIZE_SCOPE = CS_ONLY 时，销售人员发言跳过抢话筒，话筒维持 BOT', async () => {
      mockEnv.MIC_SEIZE_SCOPE = 'CS_ONLY';

      // 客户先发言建立会话
      await suite.injectMessage({ chatId: 'chat_s21_b', senderId: 'cust_s21', text: '可以试驾吗？' });
      const conv = Array.from(dbConversations.values()).find((c) => c.channel_chat_id === 'chat_s21_b');
      expect(conv).toBeDefined();
      expect((await micService.getMicStatus(conv.id)).owner).toBe('BOT');

      // 销售人员（STAFF_OTHER）发言
      const staffRes = await suite.injectMessage({
        chatId: 'chat_s21_b',
        senderId: 'sales_rep_02',
        role: 'STAFF_OTHER',
        text: '试驾车随时有',
      });
      expect(staffRes.status).toBe('STAFF_HANDLED');

      // 验证因为 CS_ONLY，跳过话筒抢夺，话筒所有权依然为 BOT
      const micStatus = await micService.getMicStatus(conv.id);
      expect(micStatus.owner).toBe('BOT');
    });
  });

  describe('5. 用例 S23: 新成员入群发言 CRM 查询超时 Fallback 兜底正常回复', () => {
    it('新成员入群发言遇 CRM 超时：四层判定 Fallback 兜底为 CUSTOMER 并正常进入缓冲应答，不阻塞初次体验', async () => {
      // 模拟网关层经历 300ms 超时熔断后，以 CUSTOMER 角色带入入站流水线
      const fallbackInboundRes = await suite.injectMessage({
        chatId: 'chat_s23',
        senderId: 'new_member_wu',
        role: 'CUSTOMER',
        text: '大家好，刚提车问一下保险',
      });

      // 验证成功进入客户消息缓冲流
      expect(fallbackInboundRes.status).toBe('PROCESSED');

      const conv = Array.from(dbConversations.values()).find((c) => c.channel_chat_id === 'chat_s23');
      expect(conv).toBeDefined();

      // 验证消息已入库并在缓冲池中排队
      const buffered = await bufferService.peekSince(conv.id, 0);
      expect(buffered.length).toBe(1);
      expect(buffered[0].text).toBe('大家好，刚提车问一下保险');

      // 验证正常预约了 3s 静默封组任务，机器人将正常答复
      const quietJob = scheduledTimerJobs.find((j) => j.type === 'quiet' && j.data?.senderId === 'new_member_wu');
      expect(quietJob).toBeDefined();
      expect(quietJob?.delay).toBe(3000);
    });
  });
});
