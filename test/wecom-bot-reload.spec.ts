import { WecomBotService } from '../src/modules/wecom/wecom-bot.service';
import type { WecomGroupMessageService } from '../src/modules/wecom/wecom-group-message.service';
import type { GatewayConfigService } from '../src/infra/gateway/gateway-config.service';
import type { Env } from '../src/config/env';
import { WSClient } from '@wecom/aibot-node-sdk';

jest.mock('@wecom/aibot-node-sdk', () => {
  return {
    WSClient: jest.fn().mockImplementation((config) => {
      return {
        config,
        connect: jest.fn(),
        disconnect: jest.fn(),
        on: jest.fn(),
      };
    }),
  };
});

describe('WecomBotService 动态热重载', () => {
  let service: WecomBotService;
  let mockGroupMsgService: Partial<WecomGroupMessageService>;
  let mockGatewayConfig: Partial<GatewayConfigService>;
  let configStore: Record<string, any>;
  let configChangeCallbacks: Record<string, Array<(key: string, val: any) => void>>;

  beforeEach(() => {
    jest.clearAllMocks();
    configStore = {};
    configChangeCallbacks = {};

    mockGroupMsgService = {
      getStats: jest.fn().mockReturnValue({
        receivedCount: 0,
        repliedCount: 0,
        handoffCount: 0,
        lastReceivedAt: null,
      }),
      handleIncomingMessage: jest.fn(),
    };

    mockGatewayConfig = {
      get: jest.fn().mockImplementation((ns: string, key: string, fallback?: any) => {
        if (configStore[ns] && configStore[ns][key] !== undefined) {
          return configStore[ns][key];
        }
        return fallback;
      }),
      onConfigChange: jest.fn().mockImplementation((ns: string, cb: any) => {
        configChangeCallbacks[ns] = configChangeCallbacks[ns] || [];
        configChangeCallbacks[ns].push(cb);
      }),
    };
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
      WECOM_BOT_ID: 'initial_bot_123',
      WECOM_BOT_SECRET: 'initial_sec_456',
      WECOM_BOT_WS_URL: 'wss://openws.work.weixin.qq.com',
      WECOM_STAFF_MENTIONS: '@客服',
      GATEWAY_URL: 'http://127.0.0.1:3003',
      GATEWAY_ENABLED: true,
      GATEWAY_SERVICE_NAME: 'ai-agent-application',
      ...overrides,
    };
  };

  it('启动时优先使用网关 CC 配置初始化长连接', async () => {
    configStore['wecom'] = {
      botId: 'cc_bot_9999',
      botSecret: 'cc_sec_9999',
    };

    service = new WecomBotService(
      createMockEnv(),
      mockGroupMsgService as any,
      mockGatewayConfig as any,
    );

    await service.onModuleInit();

    expect(WSClient).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: 'cc_bot_9999',
        secret: 'cc_sec_9999',
      }),
    );

    const status = service.getStatus();
    expect(status.configured).toBe(true);
    expect(status.enabled).toBe(true);
    expect(status.botId).toBe('cc_b****9999');
  });

  it('监听到企微凭证热变更时平滑重启长连接客户端', async () => {
    configStore['wecom'] = {
      botId: 'bot_v1',
      botSecret: 'sec_v1',
    };

    service = new WecomBotService(
      createMockEnv(),
      mockGroupMsgService as any,
      mockGatewayConfig as any,
    );

    await service.onModuleInit();
    expect(WSClient).toHaveBeenCalledTimes(1);

    // 模拟网关 CC 动态下发新凭证
    configStore['wecom'] = {
      botId: 'bot_v2',
      botSecret: 'sec_v2',
    };

    // 触发网关变更回调
    const cbs = configChangeCallbacks['wecom'] || [];
    for (const cb of cbs) {
      await cb('botId', 'bot_v2');
    }

    // 应该重新初始化新的 WSClient
    expect(WSClient).toHaveBeenCalledTimes(2);
    expect(WSClient).toHaveBeenLastCalledWith(
      expect.objectContaining({
        botId: 'bot_v2',
        secret: 'sec_v2',
      }),
    );
  });

  it('动态禁用 botEnabled 时主动优雅断开长连接', async () => {
    configStore['wecom'] = {
      botId: 'bot_v1',
      botSecret: 'sec_v1',
      botEnabled: true,
    };

    service = new WecomBotService(
      createMockEnv(),
      mockGroupMsgService as any,
      mockGatewayConfig as any,
    );

    await service.onModuleInit();
    const clientInstance = service.getClient();
    expect(clientInstance).toBeDefined();

    // 动态禁用
    configStore['wecom'].botEnabled = false;

    const cbs = configChangeCallbacks['wecom'] || [];
    for (const cb of cbs) {
      await cb('botEnabled', false);
    }

    expect(clientInstance?.disconnect).toHaveBeenCalled();
    expect(service.getClient()).toBeNull();
    expect(service.getStatus().enabled).toBe(false);
  });
});
