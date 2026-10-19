import { GatewayRegistryService } from '../src/infra/gateway/gateway-registry.service';
import type { Env } from '../src/config/env';

describe('GatewayRegistryService', () => {
  let service: GatewayRegistryService;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (service) {
      service.stopHeartbeat();
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
      WECOM_BOT_ENABLED: false,
      WECOM_STAFF_MENTIONS: '@客服',
      GATEWAY_URL: 'http://127.0.0.1:3003',
      GATEWAY_ENABLED: true,
      GATEWAY_SERVICE_NAME: 'ai-agent-application',
      GATEWAY_INSTANCE_ID: 'a3-test-1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_HEARTBEAT_INTERVAL_MS: 1000,
      ...overrides,
    };
  };

  it('成功向网关注册服务实例并携带正确 Payload 和 Headers', async () => {
    let capturedUrl = '';
    let capturedBody: any = null;
    let capturedHeaders: any = null;

    global.fetch = jest.fn().mockImplementation(async (url: string, opts: any) => {
      capturedUrl = url;
      capturedBody = JSON.parse(opts.body);
      capturedHeaders = opts.headers;
      return {
        ok: true,
        status: 200,
        text: async () => '{"success":true}',
      };
    }) as any;

    service = new GatewayRegistryService(createMockEnv({ GATEWAY_AUTH_TOKEN: 'auth-123' }));
    const success = await service.register();

    expect(success).toBe(true);
    expect(capturedUrl).toBe('http://127.0.0.1:3003/api/registry/register');
    expect(capturedBody.instanceId).toBe('a3-test-1');
    expect(capturedBody.serviceName).toBe('ai-agent-application');
    expect(capturedBody.port).toBe(3002);
    expect(capturedBody.metadata.webhookPath).toBe('/api/admin/wecom/finance-inbound');
    expect(capturedHeaders['x-gateway-token']).toBe('auth-123');
  });

  it('当网关不可达时，Fail-safe 机制应静默记录 warning 并返回 false，不抛出异常阻断进程', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:3003'));

    service = new GatewayRegistryService(createMockEnv());
    const success = await service.register();

    expect(success).toBe(false);
  });

  it('心跳续约成功', async () => {
    let capturedUrl = '';
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      return { ok: true, status: 200 };
    }) as any;

    service = new GatewayRegistryService(createMockEnv());
    const success = await service.heartbeat();

    expect(success).toBe(true);
    expect(capturedUrl).toBe('http://127.0.0.1:3003/api/registry/heartbeat');
  });

  it('当心跳返回 404（租约过期剔除）时，应自动触发重新注册', async () => {
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      callCount++;
      if (url.includes('/heartbeat')) {
        return { ok: false, status: 404 };
      }
      if (url.includes('/register')) {
        return { ok: true, status: 200 };
      }
      return { ok: false, status: 500 };
    }) as any;

    service = new GatewayRegistryService(createMockEnv());
    const success = await service.heartbeat();

    expect(success).toBe(true);
    expect(callCount).toBe(2);
  });

  it('主动下线注销实例', async () => {
    let capturedUrl = '';
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      return { ok: true, status: 200 };
    }) as any;

    service = new GatewayRegistryService(createMockEnv());
    const success = await service.deregister();

    expect(success).toBe(true);
    expect(capturedUrl).toBe('http://127.0.0.1:3003/api/registry/deregister');
  });

  it('GATEWAY_ENABLED=false 时生命周期钩子应跳过注册', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;

    service = new GatewayRegistryService(createMockEnv({ GATEWAY_ENABLED: false }));
    await service.onApplicationBootstrap();

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
