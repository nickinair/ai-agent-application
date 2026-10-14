/**
 * @file voided-audit-metrics.spec.ts
 * @description Task 4.5: “生成未发出”全量审计落库与 Prometheus 指标埋点单元测试
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §5.8.1、§14 监控与运维、附录 C 用例 S7
 */

import { MetricsService, MetricCounter } from '../src/infra/metrics.service';
import { FinalCheckService } from '../src/modules/pipeline/final-check.service';
import { BufferService } from '../src/modules/pipeline/buffer.service';
import { StateTransitionService } from '../src/modules/pipeline/state-transition.service';
import { MicrophoneService } from '../src/modules/pipeline/microphone.service';
import { MysqlService } from '../src/database/mysql.service';
import type { TurnContext, ChannelAdapter, OutboundMessage } from '../src/contracts';

describe('Task 4.5: “生成未发出”全量审计落库与 Prometheus 指标埋点测试', () => {
  let metricsService: MetricsService;

  beforeEach(() => {
    metricsService = new MetricsService();
  });

  describe('1. MetricsService 与 MetricCounter 核心机制', () => {
    it('正确累加多维度标签计数', () => {
      metricsService.recordTurnVoided('MIC_SEIZED', 100);
      metricsService.recordTurnVoided('MIC_SEIZED', 100);
      metricsService.recordTurnVoided('RECOMPUTE_ABANDONED', 100);
      metricsService.recordTurnVoided('MIC_SEIZED', 200, 3);

      expect(
        metricsService.turnVoidedTotal.get({ reason: 'MIC_SEIZED', tenant_id: '100' }),
      ).toBe(2);
      expect(
        metricsService.turnVoidedTotal.get({ reason: 'RECOMPUTE_ABANDONED', tenant_id: '100' }),
      ).toBe(1);
      expect(
        metricsService.turnVoidedTotal.get({ reason: 'MIC_SEIZED', tenant_id: '200' }),
      ).toBe(3);
      expect(
        metricsService.turnVoidedTotal.get({ reason: 'RULE_BLOCKED', tenant_id: '100' }),
      ).toBe(0);
    });

    it('导出合规的 Prometheus Exposition 格式文本', () => {
      metricsService.recordTurnVoided('MIC_SEIZED', 101, 5);
      const text = metricsService.getMetricsAsText();

      expect(text).toContain('# HELP agent_turn_voided_total');
      expect(text).toContain('# TYPE agent_turn_voided_total counter');
      expect(text).toContain('agent_turn_voided_total{reason="MIC_SEIZED",tenant_id="101"} 5');
    });

    it('支持 reset() 重置计数', () => {
      metricsService.recordTurnVoided('MIC_SEIZED', 100, 10);
      expect(metricsService.turnVoidedTotal.get({ reason: 'MIC_SEIZED', tenant_id: '100' })).toBe(10);
      metricsService.turnVoidedTotal.reset();
      expect(metricsService.turnVoidedTotal.get({ reason: 'MIC_SEIZED', tenant_id: '100' })).toBe(0);
    });
  });

  describe('2. 话筒被抢时全量审计落库与指标自增 (MIC_SEIZED)', () => {
    let finalCheckService: FinalCheckService;
    let dbQueries: Array<{ sql: string; params: any[] }>;

    beforeEach(() => {
      dbQueries = [];
      const mockMysql = {
        getPool: () => ({
          query: async (sql: string, params: any[]) => {
            dbQueries.push({ sql, params });
            return [[]];
          },
        }),
      } as unknown as MysqlService;

      const mockBuffer = {
        peekSince: jest.fn().mockResolvedValue([]),
      } as unknown as BufferService;

      const mockMic = {
        getMicStatus: jest.fn().mockResolvedValue({
          owner: 'HUMAN',
          staffId: 'staff_agent_009',
          epoch: 5,
        }),
      } as unknown as MicrophoneService;

      const mockStateTransition = {
        transition: jest.fn().mockResolvedValue(true),
      } as unknown as StateTransitionService;

      finalCheckService = new FinalCheckService(
        mockBuffer,
        mockStateTransition,
        mockMic,
        undefined,
        mockMysql,
        metricsService,
      );
    });

    it('safeSend 被话筒拦截时，落库 void_reason=MIC_SEIZED，保留草稿，并递增 Prometheus 指标', async () => {
      const ctx: TurnContext = {
        turnId: 4501,
        tenantId: 99,
        groupId: 9001,
        conversationId: 8888,
        traceId: 'tr_void_4501',
        sealedAt: Date.now() - 2000,
        reply: {
          text: '您好，为您推荐企业套餐A方案',
        },
      } as any;

      const sent = await finalCheckService.safeSend(ctx);
      expect(sent).toBe(false);
      expect(ctx.finalCheck?.verdict).toBe('VOID');

      // 验证 DB 更新 SQL 包含 void_reason 与草稿文本
      const voidQuery = dbQueries.find(
        (q) => q.sql.includes('UPDATE turn SET reply_status = \'VOIDED\'') && q.sql.includes('void_reason = ?'),
      );
      expect(voidQuery).toBeDefined();
      expect(voidQuery?.params).toContain('MIC_SEIZED');
      expect(voidQuery?.params).toContain('您好，为您推荐企业套餐A方案');
      expect(voidQuery?.params).toContain(ctx.turnId);

      // 验证指标计数递增
      expect(
        metricsService.turnVoidedTotal.get({ reason: 'MIC_SEIZED', tenant_id: '99' }),
      ).toBe(1);
    });

    it('finalCheck 门禁前置话筒拦截时，同样落库 void_reason=MIC_SEIZED 并递增指标', async () => {
      const ctx: TurnContext = {
        turnId: 4502,
        tenantId: 99,
        groupId: 9002,
        conversationId: 8888,
        traceId: 'tr_void_4502',
        reply: { text: '旧草稿回复' },
      } as any;

      const res = await finalCheckService.finalCheck(ctx);
      expect(res.verdict).toBe('VOID');

      expect(
        metricsService.turnVoidedTotal.get({ reason: 'MIC_SEIZED', tenant_id: '99' }),
      ).toBe(1);
    });
  });

  describe('3. 合并重算废弃旧草稿指标埋点 (RECOMPUTE_ABANDONED)', () => {
    let finalCheckService: FinalCheckService;

    beforeEach(() => {
      const mockBuffer = {
        peekSince: jest.fn().mockResolvedValue([
          { msgId: 'm_corr_1', text: '不对，我问的是下周一的票', createdAt: Date.now() },
        ]),
        takeInto: jest.fn().mockResolvedValue(1),
      } as unknown as BufferService;

      const mockMic = {
        getMicStatus: jest.fn().mockResolvedValue({
          owner: 'BOT',
          staffId: null,
          epoch: 1,
        }),
      } as unknown as MicrophoneService;

      finalCheckService = new FinalCheckService(
        mockBuffer,
        undefined,
        mockMic,
        undefined,
        undefined,
        metricsService,
      );
    });

    it('S4 首次纠正合并重算且已有旧草稿时，记录 RECOMPUTE_ABANDONED 埋点', async () => {
      const ctx: TurnContext = {
        turnId: 4503,
        tenantId: 88,
        groupId: 9003,
        conversationId: 7777,
        groupText: '我想查明天的票',
        reply: { text: '为您查询到明天的票价为 200 元' }, // 已生成草稿
        mergeCount: 0,
      } as any;

      const res = await finalCheckService.finalCheck(ctx);
      expect(res.action).toBe('RECOMPUTE');
      expect(ctx.mergeCount).toBe(1);

      // 验证 Prometheus 指标
      expect(
        metricsService.turnVoidedTotal.get({ reason: 'RECOMPUTE_ABANDONED', tenant_id: '88' }),
      ).toBe(1);
    });
  });

  describe('4. 规则阻断场景显式调用 recordVoided (RULE_BLOCKED)', () => {
    let finalCheckService: FinalCheckService;
    let dbQueries: Array<{ sql: string; params: any[] }>;

    beforeEach(() => {
      dbQueries = [];
      const mockMysql = {
        getPool: () => ({
          query: async (sql: string, params: any[]) => {
            dbQueries.push({ sql, params });
            return [[]];
          },
        }),
      } as unknown as MysqlService;

      const mockBuffer = {} as BufferService;

      finalCheckService = new FinalCheckService(
        mockBuffer,
        undefined,
        undefined,
        undefined,
        mockMysql,
        metricsService,
      );
    });

    it('显式调用 recordVoided 并指定 RULE_BLOCKED，完整落库草稿与指标递增', async () => {
      const ctx: TurnContext = {
        turnId: 4504,
        tenantId: 66,
        groupId: 9004,
        conversationId: 6666,
        traceId: 'tr_blocked_4504',
      } as any;

      const blockedDraft = '这是由于命中风控关键词而被阻断发出的敏感回复';
      await finalCheckService.recordVoided(ctx, 'RULE_BLOCKED', blockedDraft);

      expect(ctx.finalCheck?.verdict).toBe('VOID');

      // 验证 DB
      const voidQuery = dbQueries.find(
        (q) => q.sql.includes('UPDATE turn SET reply_status = \'VOIDED\''),
      );
      expect(voidQuery).toBeDefined();
      expect(voidQuery?.params).toContain('RULE_BLOCKED');
      expect(voidQuery?.params).toContain(blockedDraft);
      expect(voidQuery?.params).toContain(4504);

      // 验证 Prometheus 指标
      expect(
        metricsService.turnVoidedTotal.get({ reason: 'RULE_BLOCKED', tenant_id: '66' }),
      ).toBe(1);
    });
  });
});
