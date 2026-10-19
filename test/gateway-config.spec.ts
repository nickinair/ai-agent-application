import { GatewayConfigService, GatewayConfigChangeEvent } from '../src/infra/gateway/gateway-config.service';
import type { Env } from '../src/config/env';

describe('GatewayConfigService', () => {
  let service: GatewayConfigService;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    if (service) {
      await service.beforeApplicationShutdown();
    }
  });

  const createMockEnv = (overrides: Partial<Env> = {}): Env => {
    return {
      NODE_ENV: 'test',
      PORT: 3002,
      MYSQL_URL: 'mysql://localhost:3306/test',
      REDIS_URL: 'redis://localhost:6379',
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: 6379,
      REDIS_DB: 0,
      CRM_BASE_URL: 'http://localhost:3001',
      CRM_SERVICE_TOKEN: 'token',
      CRM_TIMEOUT_MS: 800,
      QUIET_WINDOW_MS: 3000,
      HARD_TIMEOUT_MS: 15000,
      GROUP_MAX_MESSAGES: 5,
      WECOM_BOT_ENABLED: true,
      WECOM_BOT_ID: 'env_bot_id',
      WECOM_BOT_SECRET: 'env_bot_secret',
      WECOM_STAFF_MENTIONS: '@客服',
      GATEWAY_URL: 'http://127.0.0.1:3003',
      GATEWAY_ENABLED: true,
      GATEWAY_SERVICE_NAME: 'ai-agent-application',
      ...overrides,
    };
  };

  it('成功从网关拉取命名空间配置并写入内存缓存', async () => {
    const mockData = {
      botId: 'remote_bot_123',
      botSecret: 'remote_secret_456',
      botWsUrl: 'wss://test.wecom.work',
    };

    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/config/wecom')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: mockData }),
        };
      }
      return { ok: false, status: 404 };
    }) as any;

    service = new GatewayConfigService(createMockEnv());
    const res = await service.fetchNamespaceConfig('wecom');

    expect(res).toEqual(mockData);
    expect(service.get('wecom', 'botId')).toBe('remote_bot_123');
    expect(service.get('wecom', 'botSecret')).toBe('remote_secret_456');
    expect(service.get('wecom', 'botWsUrl')).toBe('wss://test.wecom.work');
  });

  it('网关未配置或网络异常时平滑降级使用 fallback 参数', async () => {
    global.fetch = jest.fn().mockImplementation(async () => {
      throw new Error('Connection refused');
    }) as any;

    service = new GatewayConfigService(createMockEnv());
    const res = await service.fetchNamespaceConfig('wecom');

    expect(res).toEqual({});
    // 降级使用 fallback
    expect(service.get('wecom', 'botId', 'fallback_bot')).toBe('fallback_bot');
  });

  it('监听到 ag:cfg:changed 广播后自动刷新配置并触发回调', async () => {
    const initialData = { botId: 'v1_bot' };
    const updatedData = { botId: 'v2_bot' };

    let fetchCount = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      fetchCount++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: fetchCount > 1 ? updatedData : initialData,
        }),
      };
    }) as any;

    service = new GatewayConfigService(createMockEnv());
    await service.fetchNamespaceConfig('wecom');
    expect(service.get('wecom', 'botId')).toBe('v1_bot');

    let listenerTriggered = false;
    let receivedKey = '';
    let receivedVal: any = null;

    service.onConfigChange('wecom', (key, val) => {
      listenerTriggered = true;
      receivedKey = key;
      receivedVal = val;
    });

    const event: GatewayConfigChangeEvent = {
      namespace: 'wecom',
      key: 'botId',
      version: 2,
      timestamp: Date.now(),
    };

    await service.handleChannelMessage(JSON.stringify(event));

    expect(listenerTriggered).toBe(true);
    expect(receivedKey).toBe('botId');
    expect(receivedVal).toBe('v2_bot');
    expect(service.get('wecom', 'botId')).toBe('v2_bot');
  });

  it('GATEWAY_ENABLED=false 时跳过网关预拉取', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock;

    service = new GatewayConfigService(createMockEnv({ GATEWAY_ENABLED: false }));
    await service.onApplicationBootstrap();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
