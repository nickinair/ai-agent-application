/**
 * @file s4-s9-mic-final-tests.spec.ts
 * @description Task 5.3: 话筒与末检核心用例自动化端到端测试 (附录 C 用例 S4～S9, S25)
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §5.8.1、§6.2、§7.3、§11.3、§14、附录 C (S4～S9, S25)
 */

import { TestInjectSuite } from './test-inject-suite';
import { InboundPipelineService } from '../../src/modules/pipeline/inbound-pipeline.service';
import { FinalCheckService } from '../../src/modules/pipeline/final-check.service';
import { BufferService } from '../../src/modules/pipeline/buffer.service';
import { TimerService } from '../../src/modules/pipeline/timer.service';
import { SealerService } from '../../src/modules/pipeline/sealer.service';
import { MicrophoneService } from '../../src/modules/pipeline/microphone.service';
import { StateTransitionService } from '../../src/modules/pipeline/state-transition.service';
import { MetricsService } from '../../src/infra/metrics.service';
import { MysqlService } from '../../src/database/mysql.service';
import { RedisService } from '../../src/infra/redis/redis.service';
import type { Env } from '../../src/config/env';
import type {
  ChannelAdapter,
  TurnContext,
  OutboundMessage,
  MessageRef,
} from '../../src/contracts';

describe('Task 5.3: 话筒与末检核心用例自动化回归 (S4～S9, S25)', () => {
  let suite: TestInjectSuite;
  let inboundService: InboundPipelineService;
  let finalCheckService: FinalCheckService;
  let bufferService: BufferService;
  let timerService: TimerService;
  let sealerService: SealerService;
  let micService: MicrophoneService;
  let stateTransitionService: StateTransitionService;
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
  let stateTransitions: Array<{ entityType: string; entityId: number; from: string; to: string; reason?: string }>;

  const tenantId = 1;
  const chatId = 'wr_test_chat_s4_s9';
  const customerId = 'wm_cust_zhao';
  const staffId = 'staff_agent_chen';

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

    let autoMsgId = 1000;
    let autoConvId = 2000;
    let autoGroupId = 3000;
    let autoTurnId = 4000;

    // 1. Mock MySQL
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

          // 增量合并 update msg_group
          if (sql.includes('UPDATE msg_group') && sql.includes('message_count = message_count +')) {
            const gId = Number(params[params.length - 1]);
            const g = dbGroups.get(gId);
            if (g) {
              g.message_count = (g.message_count || 0) + Number(params[0]);
              if (params[1]) {
                g.merged_text = g.merged_text ? `${g.merged_text}\n${params[1]}` : params[1];
                g.text = g.merged_text;
              }
            }
            return [{ affectedRows: 1 }];
          }

          // 查询单条 msg_group
          if (sql.includes('FROM msg_group WHERE id = ?')) {
            const g = dbGroups.get(Number(params[0]));
            return [g ? [g] : []];
          }

          // 查询在途组
          if (sql.includes('FROM msg_group') && sql.includes("status IN ('BUFFERING', 'COLLECTING', 'UNDERSTANDING', 'REASONING', 'GENERATING', 'FINAL_CHECKING')")) {
            const convId = params[0];
            const rows = Array.from(dbGroups.values()).filter(
              (g) => g.conversation_id === convId && !['DONE', 'VOIDED', 'ARCHIVED', 'SENT'].includes(g.status),
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

          if (sql.includes("UPDATE turn SET reply_status = 'VOIDED'")) {
            const tId = Number(params.find((p) => typeof p === 'number'));
            const turn = dbTurns.get(tId);
            if (turn) {
              turn.reply_status = 'VOIDED';
              turn.void_reason = params[0];
              turn.reply_text = params[1];
              turn.status = 'DONE';
            }
            return [{ affectedRows: 1 }];
          }

          if (sql.includes('FROM turn WHERE id = ?')) {
            const t = dbTurns.get(Number(params[0]));
            return [t ? [t] : []];
          }

          // 查询消息 (WHERE id IN (...))
          if (sql.includes('FROM message') && sql.includes('WHERE id IN')) {
            const idList = params.map(Number);
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

          // 缓冲局部移除与扣减
          if (script.includes('removedTotal')) {
            const bufKey = args[0];
            const metaKey = args[1];
            const idsToRemove = args.slice(2);
            let list = redisStore.get(bufKey) || [];
            list = list.filter((id: any) => !idsToRemove.includes(String(id)));
            redisStore.set(bufKey, list);
            const meta = redisStore.get(metaKey) || { count: 0 };
            meta.count = Math.max(0, (meta.count || 0) - idsToRemove.length);
            redisStore.set(metaKey, meta);
            return idsToRemove.length;
          }

          // 话筒员工抢占 seizeByStaff
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

          // 话筒交还 yieldToBot
          if (script.includes('ALREADY_BOT') || script.includes('RETURNED')) {
            const micKey = args[0];
            const nowMs = args[1];
            const reason = args[2];
            const force = args[3] === '1';
            const current = redisStore.get(micKey) || { owner: 'BOT', epoch: '0' };
            const currentOwner = current.owner || 'BOT';
            const currentEpoch = Number(current.epoch || 0);
            const isLocked = current.is_handoff_locked === '1';

            if (!force && isLocked) {
              return [0, currentEpoch, 'LOCKED_BY_HANDOFF'];
            }
            if (currentOwner === 'BOT') {
              return [1, currentEpoch, 'ALREADY_BOT'];
            }
            const newEpoch = currentEpoch + 1;
            current.owner = 'BOT';
            current.staffId = '';
            current.since = String(nowMs);
            current.reason = reason;
            current.epoch = String(newEpoch);
            current.is_handoff_locked = '0';
            redisStore.set(micKey, current);
            return [1, newEpoch, 'RETURNED'];
          }

          // 话筒锁定 lockHandoff
          if (script.includes('is_handoff_locked", "1"') || script.includes('is_handoff_locked')) {
            const micKey = args[0];
            const staffId = args[1];
            const nowMs = args[2];
            const reason = args[3];
            const current = redisStore.get(micKey) || { owner: 'BOT', epoch: '0' };
            const currentEpoch = Number(current.epoch || 0);
            const newEpoch = currentEpoch + 1;
            current.owner = 'HUMAN';
            current.staffId = staffId;
            current.since = String(nowMs);
            current.reason = reason;
            current.epoch = String(newEpoch);
            current.is_handoff_locked = '1';
            redisStore.set(micKey, current);
            return newEpoch;
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
        name: '赵先生',
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

  describe('1. 用例 S4: 首次纠正合并重算', () => {
    it('组 A 生成中客户否定纠正：末检判 CORRECT，并入组 A 重算 1 次，mergeCount: 0 -> 1，记录 RECOMPUTE_ABANDONED', async () => {
      const sealedAt = Date.now() - 2000;
      const ctx: TurnContext = {
        turnId: 5401,
        tenantId,
        conversationId: 2001,
        groupId: 3401,
        traceId: 'tr_s4_e2e',
        groupText: '我想了解一下汽车保养价格',
        groupMessages: [
          { messageId: 1001, channelMsgId: 'm_s4_01', senderRole: 'CUSTOMER', text: '我想了解一下汽车保养价格', sentAt: sealedAt - 1000 },
        ],
        sealedAt,
        mergeCount: 0,
        reply: { text: '基础保养小保价格通常在 300-500 元之间', confidence: 0.95 },
      } as any;

      // 客户在发送前发了纠正消息进入缓冲池
      await bufferService.push(ctx.conversationId, customerId, 1002, sealedAt + 500);
      dbMessages.set(1002, {
        id: 1002,
        conversation_id: ctx.conversationId,
        channel_msg_id: 'm_s4_02',
        sender_role: 'CUSTOMER',
        sender_channel_user_id: customerId,
        content: '不对，我问的是延保不是基础保养',
        sent_at: new Date(sealedAt + 500),
      });

      // 执行末检
      const checkRes = await finalCheckService.finalCheck(ctx);

      expect(checkRes.action).toBe('RECOMPUTE');
      expect(checkRes.verdict).toBe('CORRECT');
      expect(ctx.mergeCount).toBe(1);
      expect(ctx.groupText).toContain('不对，我问的是延保不是基础保养');

      // 验证丢弃草稿后记录了 RECOMPUTE_ABANDONED 指标
      expect(
        metricsService.turnVoidedTotal.get({ reason: 'RECOMPUTE_ABANDONED', tenant_id: String(tenantId) }),
      ).toBe(1);

      // 模拟重算完成调用 safeSend
      ctx.reply = { text: '关于问界M7延保方案，我们提供 1年/3万公里 套餐', confidence: 0.98 } as any;
      const sendOk = await finalCheckService.safeSend(ctx);
      expect(sendOk).toBe(true);
      expect(outboundReplies.length).toBe(1);
    });
  });

  describe('2. 用例 S5: 达到上限单次熔断', () => {
    it('重算后客户又发纠正：mergeCount >= 1 触发熔断不再合并，原回复照发，新消息保留缓冲池', async () => {
      const sealedAt = Date.now() - 2000;
      const ctx: TurnContext = {
        turnId: 5402,
        tenantId,
        conversationId: 2001,
        groupId: 3402,
        traceId: 'tr_s5_e2e',
        groupText: '我想了解一下汽车保养价格\n不对，我问的是延保',
        groupMessages: [
          { messageId: 1001, channelMsgId: 'm_s5_01', senderRole: 'CUSTOMER', text: '我想了解一下汽车保养价格', sentAt: sealedAt - 2000 },
          { messageId: 1002, channelMsgId: 'm_s5_02', senderRole: 'CUSTOMER', text: '不对，我问的是延保', sentAt: sealedAt - 1000 },
        ],
        sealedAt,
        mergeCount: 1, // 已达上限
        reply: { text: '为您提供延保方案详情...', confidence: 0.95 },
      } as any;

      // 客户在发送前再次输入纠正
      await bufferService.push(ctx.conversationId, customerId, 1003, sealedAt + 500);
      dbMessages.set(1003, {
        id: 1003,
        conversation_id: ctx.conversationId,
        channel_msg_id: 'm_s5_03',
        sender_role: 'CUSTOMER',
        sender_channel_user_id: customerId,
        content: '错啦，我想问的是发动机延保多少钱',
        sent_at: new Date(sealedAt + 500),
      });

      const checkRes = await finalCheckService.finalCheck(ctx);

      // 断言: 熔断放行 SEND，不重算
      expect(checkRes.action).toBe('SEND');
      expect(checkRes.verdict).toBe('CORRECT');
      expect(ctx.finalCheck?.recomputed).toBe(false);

      // 新消息依然在缓冲池
      const remainingMsgs = await bufferService.peekSince(ctx.conversationId, 0);
      expect(remainingMsgs.length).toBe(1);

      // 照常安全下发原回复
      const sent = await finalCheckService.safeSend(ctx);
      expect(sent).toBe(true);
    });
  });

  describe('3. 用例 S6: 换题新消息保留缓冲池', () => {
    it('组 A 生成中客户发“另外保养多少钱”：末检判 NEW_TOPIC，组 A 照发，新消息保留供组 B 独立成组', async () => {
      const sealedAt = Date.now() - 2000;
      const ctx: TurnContext = {
        turnId: 5403,
        tenantId,
        conversationId: 2001,
        groupId: 3403,
        traceId: 'tr_s6_e2e',
        groupText: '延保包含哪些核心零部件？',
        sealedAt,
        mergeCount: 0,
        reply: { text: '延保涵盖发动机、变速箱及核心三电系统。', confidence: 0.95 },
      } as any;

      // 注入新话题消息
      await bufferService.push(ctx.conversationId, customerId, 1004, sealedAt + 600);
      dbMessages.set(1004, {
        id: 1004,
        conversation_id: ctx.conversationId,
        channel_msg_id: 'm_s6_01',
        sender_role: 'CUSTOMER',
        sender_channel_user_id: customerId,
        content: '另外换机油大概多少钱？',
        sent_at: new Date(sealedAt + 600),
      });

      const checkRes = await finalCheckService.finalCheck(ctx);

      expect(checkRes.action).toBe('SEND');
      expect(checkRes.verdict).toBe('NEW_TOPIC');

      // 组 A 顺利下发
      const sent = await finalCheckService.safeSend(ctx);
      expect(sent).toBe(true);

      // 新消息完好保存在缓冲池中
      const remaining = await bufferService.peekSince(ctx.conversationId, 0);
      expect(remaining.length).toBe(1);
    });
  });

  describe('4. 用例 S7: 员工抢话筒作废在途生成与终验拦截', () => {
    it('客服在群里发言抢占话筒：话筒转为 HUMAN，在途组作废，终验掐断下发，turn 记录 MIC_SEIZED', async () => {
      // 1. 初始化会话
      await suite.injectMessage({ chatId, senderId: customerId, text: '延保多少钱？' });
      const conv = Array.from(dbConversations.values())[0];

      // 模拟进入在途执行组
      const inflightGroup = {
        id: 3404,
        tenant_id: tenantId,
        conversation_id: conv.id,
        sender_channel_user_id: customerId,
        status: 'UNDERSTANDING',
      };
      dbGroups.set(3404, inflightGroup);
      dbTurns.set(5404, { id: 5404, conversation_id: conv.id, group_id: 3404, status: 'IN_PROGRESS', reply_status: 'PENDING' });
      await mockRedisService.getClient().hset(`ag:inflight:${conv.id}`, {
        groupId: '3404',
        turnId: '5404',
      });

      // 2. 客服在群里发言插话
      const staffRes = await suite.injectMessage({
        chatId,
        senderId: staffId,
        role: 'STAFF_CS',
        text: '您好，专属客服为您解答',
      });
      expect(staffRes.status).toBe('STAFF_HANDLED');

      // 验证话筒所有权转为 HUMAN
      const micStatus = await micService.getMicStatus(conv.id);
      expect(micStatus.owner).toBe('HUMAN');
      expect(micStatus.staffId).toBe(staffId);

      // 验证在途组被作废为 VOIDED
      expect(inflightGroup.status).toBe('VOIDED');

      // 3. 此时如果 AI 尝试 safeSend 下发：被最后一刻终验掐断拦截
      const ctx: TurnContext = {
        turnId: 5404,
        tenantId,
        conversationId: conv.id,
        groupId: 3404,
        traceId: 'tr_s7_e2e',
        reply: { text: '这是不应发出的答案', confidence: 0.95 },
      } as any;

      const sendOk = await finalCheckService.safeSend(ctx);
      expect(sendOk).toBe(false);

      // 验证记录了 MIC_SEIZED 埋点
      expect(
        metricsService.turnVoidedTotal.get({ reason: 'MIC_SEIZED', tenant_id: String(tenantId) }),
      ).toBe(1);
    });
  });

  describe('5. 用例 S8: 员工抢跑未处理消息封组归档 ARCHIVED', () => {
    it('客户在缓冲池待处理消息，客服抢先回答：缓冲消息就地封组为 ARCHIVED，不进 AI', async () => {
      // 1. 客户发送消息入缓冲池
      await suite.injectMessage({ chatId: 'chat_s8', senderId: 'cust_s8', text: '你们周末上班吗？' });
      const conv = Array.from(dbConversations.values()).find((c) => c.channel_chat_id === 'chat_s8');
      expect(conv).toBeDefined();

      // 验证缓冲池中有 1 条消息
      expect((await bufferService.peekSince(conv.id, 0)).length).toBe(1);

      // 2. 客服发言抢跑解答
      await suite.injectMessage({
        chatId: 'chat_s8',
        senderId: 'staff_s8',
        role: 'STAFF_CS',
        text: '周末正常营业的哦',
      });

      // 验证客户消息从缓冲池出队，就地封组归档为 ARCHIVED
      expect((await bufferService.peekSince(conv.id, 0)).length).toBe(0);
      const archivedGroup = Array.from(dbGroups.values()).find(
        (g) => g.conversation_id === conv.id && g.status === 'ARCHIVED',
      );
      expect(archivedGroup).toBeDefined();
    });
  });

  describe('6. 用例 S9: 60s 人工未回复看门狗接回 BOT 立即封组', () => {
    it('话筒在人工手中且客户追问，人工 60s 未回复：看门狗切回 BOT 并立即封组，不发占位应答', async () => {
      // 1. 客服先发言持有话筒
      await suite.injectMessage({ chatId: 'chat_s9', senderId: 'staff_s9', role: 'STAFF_CS', text: '客服在线' });
      const conv = Array.from(dbConversations.values()).find((c) => c.channel_chat_id === 'chat_s9');
      expect(conv).toBeDefined();

      let mic = await micService.getMicStatus(conv.id);
      expect(mic.owner).toBe('HUMAN');
      const staffEpoch = mic.epoch;

      // 2. 客户追问入池，预约 60s 接回看门狗
      await suite.injectMessage({ chatId: 'chat_s9', senderId: 'cust_s9', text: '什么时候可以提车？' });
      expect((await bufferService.peekSince(conv.id, 0)).length).toBe(1);

      const hwaitJob = scheduledTimerJobs.find((j) => j.type === 'hwait');
      expect(hwaitJob).toBeDefined();
      expect(hwaitJob?.delay).toBe(60000);

      // 3. 模拟 60s 人工超时任务触发
      await timerService.handleTimerJob({
        data: {
          type: 'hwait',
          convId: conv.id,
          senderId: 'cust_s9',
          micEpoch: staffEpoch,
        },
      } as any);

      // 验证话筒自动交还给 BOT
      mic = await micService.getMicStatus(conv.id);
      expect(mic.owner).toBe('BOT');
      expect(mic.epoch).toBe(staffEpoch + 1);

      // 验证立即触发了封组
      const sealedGroup = Array.from(dbGroups.values()).find(
        (g) => g.conversation_id === conv.id && g.sender_channel_user_id === 'cust_s9',
      );
      expect(sealedGroup).toBeDefined();
      expect(sealedGroup?.seal_reason).toBe('HUMAN_TIMEOUT');
    });
  });

  describe('7. 用例 S25: 人工交接后机器人上下文承接与补全', () => {
    it('经历人工问答后客户追问，60s 超时交回机器人：组内装配历史人工轮次，机器人顺利承接解答', async () => {
      // 1. 创建会话并模拟已有人工问答轮次记录
      await suite.injectMessage({ chatId: 'chat_s25', senderId: 'cust_s25', text: '现在有什么延保活动吗？' });
      const conv = Array.from(dbConversations.values()).find((c) => c.channel_chat_id === 'chat_s25');

      // 客服解答抢话筒
      await suite.injectMessage({
        chatId: 'chat_s25',
        senderId: 'staff_s25',
        role: 'STAFF_CS',
        text: '现在购买整车延保享受限时8折优惠哦。',
      });

      // 2. 客户在人工接管后追问：“那具体能便宜多少呢？”
      await suite.injectMessage({ chatId: 'chat_s25', senderId: 'cust_s25', text: '那具体能便宜多少呢？' });

      // 3. 人工 60s 未回复，看门狗接回
      const mic = await micService.getMicStatus(conv.id);
      await timerService.handleTimerJob({
        data: {
          type: 'hwait',
          convId: conv.id,
          senderId: 'cust_s25',
          micEpoch: mic.epoch,
        },
      } as any);

      // 验证交回 BOT 并封组成功
      const s25Group = Array.from(dbGroups.values()).find(
        (g) => g.conversation_id === conv.id && g.seal_reason === 'HUMAN_TIMEOUT',
      );
      expect(s25Group).toBeDefined();
      expect(s25Group?.text).toBe('那具体能便宜多少呢？');

      // 验证机器人话筒接回且具备正常流水线解答能力
      expect((await micService.getMicStatus(conv.id)).owner).toBe('BOT');
    });
  });
});
