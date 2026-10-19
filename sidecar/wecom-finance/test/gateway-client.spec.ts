import { GatewayClient } from '../src/gateway/gateway-client';
import { HttpDispatcher } from '../src/dispatcher/http-dispatcher';
import type { InboundFinanceEvent } from '../src/types/finance.types';

describe('GatewayClient & Dynamic HttpDispatcher', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('GatewayClient (SRF & CC)', () => {
    it('能够成功从配置中心 (CC) 获取命名空间动态配置', async () => {
      let capturedUrl = '';
      let capturedHeaders: any = null;

      global.fetch = jest.fn().mockImplementation(async (url: string, opts: any) => {
        capturedUrl = url;
        capturedHeaders = opts?.headers;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: {
              pollIntervalMs: 500,
              batchSize: 200,
            },
          }),
        };
      }) as any;

      const client = new GatewayClient({
        gatewayUrl: 'http://127.0.0.1:3003',
        namespace: 'wecom-finance',
        authToken: 'gw-secret-123',
      });

      const config = await client.fetchRemoteConfig();
      expect(capturedUrl).toBe('http://127.0.0.1:3003/api/config/wecom-finance');
      expect(capturedHeaders['x-gateway-token']).toBe('gw-secret-123');
      expect(config).toEqual({ pollIntervalMs: 500, batchSize: 200 });
    });

    it('配置中心网络异常时应平滑返回空对象 (Fail-safe)', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const client = new GatewayClient({
        gatewayUrl: 'http://127.0.0.1:3003',
      });

      const config = await client.fetchRemoteConfig();
      expect(config).toEqual({});
    });

    it('能够成功向注册中心 (SRF) 注册自身并发送心跳保活', async () => {
      let registered = false;
      let heartbeatOk = false;

      global.fetch = jest.fn().mockImplementation(async (url: string, opts: any) => {
        if (url.includes('/register')) {
          const body = JSON.parse(opts.body);
          if (body.serviceName === 'wecom-finance') {
            registered = true;
            return { ok: true, status: 200, text: async () => '{"success":true}' };
          }
        }
        if (url.includes('/heartbeat')) {
          heartbeatOk = true;
          return { ok: true, status: 200, text: async () => '{"success":true}' };
        }
        return { ok: false, status: 500 };
      }) as any;

      const client = new GatewayClient({
        gatewayUrl: 'http://127.0.0.1:3003',
        serviceName: 'wecom-finance',
      });

      const regResult = await client.register();
      expect(regResult).toBe(true);
      expect(registered).toBe(true);

      const hbResult = await client.heartbeat();
      expect(hbResult).toBe(true);
      expect(heartbeatOk).toBe(true);
    });

    it('心跳返回 404 时能够自动触发重新注册', async () => {
      let registerCallCount = 0;

      global.fetch = jest.fn().mockImplementation(async (url: string) => {
        if (url.includes('/heartbeat')) {
          return { ok: false, status: 404 };
        }
        if (url.includes('/register')) {
          registerCallCount++;
          return { ok: true, status: 200, text: async () => '{"success":true}' };
        }
        return { ok: false, status: 500 };
      }) as any;

      const client = new GatewayClient();
      const res = await client.heartbeat();
      expect(res).toBe(true);
      expect(registerCallCount).toBe(1);
    });

    it('能够从注册中心 (SRF) 动态发现 a3 实例并拼装 Webhook 目标地址', async () => {
      global.fetch = jest.fn().mockImplementation(async (url: string) => {
        if (url.includes('/api/registry/instances/ai-agent-application')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              data: [
                {
                  instanceId: 'a3-node-1',
                  serviceName: 'ai-agent-application',
                  host: '10.0.1.20',
                  port: 3002,
                  metadata: {
                    webhookPath: '/api/admin/wecom/finance-inbound',
                  },
                },
              ],
            }),
          };
        }
        return { ok: false, status: 404 };
      }) as any;

      const client = new GatewayClient({
        gatewayUrl: 'http://127.0.0.1:3003',
        a3ServiceName: 'ai-agent-application',
      });

      const discoveredUrl = await client.discoverA3WebhookUrl();
      expect(discoveredUrl).toBe('http://10.0.1.20:3002/api/admin/wecom/finance-inbound');
    });

    it('当网关无可用 a3 实例时返回 null', async () => {
      global.fetch = jest.fn().mockImplementation(async () => {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: [] }),
        };
      }) as any;

      const client = new GatewayClient();
      const discoveredUrl = await client.discoverA3WebhookUrl();
      expect(discoveredUrl).toBeNull();
    });
  });

  describe('HttpDispatcher 动态解析集成', () => {
    const mockEvent: InboundFinanceEvent = {
      seq: 100,
      msgid: 'MSG_TEST_001',
      isExternalRoom: true,
      sender: 'wm_test',
      timestamp: Date.now(),
      msgtype: 'text',
      contentSummary: '测试内容',
      payload: {
        msgid: 'MSG_TEST_001',
        action: 'send',
        from: 'wm_test',
        tolist: [],
        msgtime: Date.now(),
        msgtype: 'text',
        text: { content: '测试内容' },
      },
    };

    it('优先使用 urlResolver 动态发现的 a3 地址进行投递', async () => {
      let postedUrl = '';

      global.fetch = jest.fn().mockImplementation(async (url: string) => {
        postedUrl = url;
        return { ok: true, status: 200, text: async () => 'ok' };
      }) as any;

      const dispatcher = new HttpDispatcher({
        webhookUrl: 'http://localhost:3002/fallback-url',
        urlResolver: async () => 'http://dynamic-host:3002/api/admin/wecom/finance-inbound',
      });

      const success = await dispatcher.dispatch(mockEvent);
      expect(success).toBe(true);
      expect(postedUrl).toBe('http://dynamic-host:3002/api/admin/wecom/finance-inbound');
    });

    it('当 urlResolver 返回 null 时平滑降级使用本地静态 webhookUrl', async () => {
      let postedUrl = '';

      global.fetch = jest.fn().mockImplementation(async (url: string) => {
        postedUrl = url;
        return { ok: true, status: 200, text: async () => 'ok' };
      }) as any;

      const dispatcher = new HttpDispatcher({
        webhookUrl: 'http://fallback-host:3002/api/admin/wecom/finance-inbound',
        urlResolver: async () => null,
      });

      const success = await dispatcher.dispatch(mockEvent);
      expect(success).toBe(true);
      expect(postedUrl).toBe('http://fallback-host:3002/api/admin/wecom/finance-inbound');
    });
  });
});
