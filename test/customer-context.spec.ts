/**
 * @file customer-context.spec.ts
 * @description 群名称解析器与 CRM 客户上下文装配单元测试
 */

import { CustomerContextService } from '../src/modules/pipeline/customer-context.service';
import type { Env } from '../src/config/env';

describe('客户上下文装配测试 (CustomerContextService)', () => {
  let service: CustomerContextService;

  const mockEnv: Env = {
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
  };

  beforeEach(() => {
    service = new CustomerContextService(mockEnv);
    // 重置全局 fetch
    (global as any).fetch = jest.fn();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('1. 群名称正则匹配 (parseGroupName)', () => {
    it('匹配标准群名：姓名-手机号-车型-产品-已购状态', () => {
      const parsed = service.parseGroupName('张三-13812345678-问界M5-整车延保-已购');

      expect(parsed.name).toBe('张三');
      expect(parsed.phone).toBe('13812345678');
      expect(parsed.phoneMasked).toBe('138****5678');
      expect(parsed.vehicle).toBe('问界M5');
      expect(parsed.product).toBe('整车延保');
      expect(parsed.bought).toBe(true);
    });

    it('匹配方案 §5.3 典型群名：姓名-手机号-产品-未购', () => {
      const parsed = service.parseGroupName('李四-13900001111-整车延保-未购');

      expect(parsed.name).toBe('李四');
      expect(parsed.phone).toBe('13900001111');
      expect(parsed.phoneMasked).toBe('139****1111');
      expect(parsed.product).toBe('整车延保');
      expect(parsed.bought).toBe(false);
    });

    it('匹配简写群名：姓名-手机号-车型', () => {
      const parsed = service.parseGroupName('王五-13766667777-问界M7');

      expect(parsed.name).toBe('王五');
      expect(parsed.vehicle).toBe('问界M7');
      expect(parsed.bought).toBeUndefined();
    });

    it('匹配 3 段式产品群名：姓名-手机号-产品', () => {
      const parsed = service.parseGroupName('赵女士-13900001111-整车延保');

      expect(parsed.name).toBe('赵女士');
      expect(parsed.phone).toBe('13900001111');
      expect(parsed.phoneMasked).toBe('139****1111');
      expect(parsed.product).toBe('整车延保');
      expect(parsed.bought).toBeUndefined();
    });

    it('非法或空群名应返回空对象，不抛出异常', () => {
      expect(service.parseGroupName('')).toEqual({});
      expect(service.parseGroupName('VIP优质客户交流群')).toEqual({});
    });
  });

  describe('2. CRM 接口调用与画像整合 (assembleCustomerProfile)', () => {
    it('CRM 正常响应时成功将车辆与订单信息聚合进画像', async () => {
      const mockCrmResponse = {
        customer: {
          id: 1001,
          name: '张三先生',
          phoneMasked: '138****5678',
        },
        vehicles: [
          {
            brand: '问界',
            model: '问界M5 智驾版',
            vinMasked: 'WAU***888',
            purchaseDate: '2023-10-01',
          },
        ],
        orders: [
          {
            orderCode: 'ORD_20261014_01',
            status: 'PAID',
            createdAt: 1718000000000,
            items: [
              {
                productName: '整车延保 3年/10万公里',
                salePrice: 5999,
              },
            ],
          },
        ],
        purchasedProducts: ['整车延保'],
      };

      (global as any).fetch.mockResolvedValue({
        ok: true,
        json: async () => mockCrmResponse,
      });

      const profile = await service.assembleCustomerProfile('张三-13812345678-问界M5-整车延保-未购');

      expect(profile.name).toBe('张三先生');
      expect(profile.phoneMasked).toBe('138****5678');
      expect(profile.vehicle).toBe('问界M5 智驾版');
      expect(profile.bought).toBe(true);
      expect(profile.vehicles?.length).toBe(1);
      expect(profile.boughtProducts?.length).toBe(1);

      expect((global as any).fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/open/agent/customer-context?phone=13812345678'),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Agent-Token': 'mock_token',
          }),
        }),
      );
    });

    it('当 CRM 接口网络异常或超时降级时，安全使用群名解析结果作为兜底', async () => {
      (global as any).fetch.mockRejectedValue(new Error('Connection refused'));

      const profile = await service.assembleCustomerProfile('张三-13812345678-问界M5-整车延保-未购');

      expect(profile.name).toBe('张三');
      expect(profile.phoneMasked).toBe('138****5678');
      expect(profile.vehicle).toBe('问界M5');
      expect(profile.product).toBe('整车延保');
      expect(profile.bought).toBe(false);
    });
  });
});
