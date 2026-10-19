import { CONFIG_NAMESPACES, loadConfigCenter, mapRuntime, mergeNamespaces } from '../src/config/config-center';

const quiet = { log: jest.fn(), warn: jest.fn() };

function fakeFetch(namespaces: Record<string, Record<string, unknown>>, status = 200) {
  return jest.fn(async (url: string, init?: RequestInit) => {
    const ns = decodeURIComponent(String(url).split('/api/config/')[1]);
    return { ok: status === 200, status, json: async () => ({ success: true, data: namespaces[ns] ?? {} }), init } as any;
  });
}

describe('配置中心加载（agent-shared + agent-app）', () => {
  it('读本服务的两个命名空间，agent-app 覆盖 agent-shared', async () => {
    expect(CONFIG_NAMESPACES).toEqual(['agent-shared', 'agent-app']);
    const env: NodeJS.ProcessEnv = { GATEWAY_URL: 'http://gw:3003/', GATEWAY_AUTH_TOKEN: 't0k', CRM_BASE_URL: 'http://local' };
    const f = fakeFetch({
      'agent-shared': { CRM_BASE_URL: 'http://crm', CRM_SERVICE_TOKEN: 'shared' },
      'agent-app': { CRM_SERVICE_TOKEN: 'app', WECOM_BOT_ID: 'bot1', WECOM_BOT_ENABLED: true, HUMAN_WAIT_TIMEOUT_MS: 60000 },
    });
    const r = await loadConfigCenter(env, f as any, quiet);
    expect(r.status).toBe('loaded');
    expect(f.mock.calls.map((c) => c[0])).toEqual(['http://gw:3003/api/config/agent-shared', 'http://gw:3003/api/config/agent-app', 'http://gw:3003/api/config/runtime']);
    expect((f.mock.calls[0][1] as any).headers).toEqual({ 'x-gateway-token': 't0k' });
    expect(env).toMatchObject({ CRM_BASE_URL: 'http://crm', CRM_SERVICE_TOKEN: 'app', WECOM_BOT_ID: 'bot1', HUMAN_WAIT_TIMEOUT_MS: '60000' });
    expect(env.WECOM_BOT_ENABLED).toBeUndefined(); // 按机器决定，只取本地
  });

  it('连接类配置不被覆盖；非大写下划线的键（如 wecom-finance 的小驼峰键）忽略', () => {
    const { values, ignored } = mergeNamespaces([{ MYSQL_URL: 'x', GATEWAY_URL: 'y', corpid: 'ww1', driverMode: 'native', WECOM_CORPID: 'ww1' }]);
    expect(values).toEqual({ WECOM_CORPID: 'ww1' });
    expect(ignored.sort()).toEqual(['GATEWAY_URL', 'MYSQL_URL', 'corpid', 'driverMode']);
  });

  it('日志只打印键名，不打印值', async () => {
    const log = { log: jest.fn(), warn: jest.fn() };
    await loadConfigCenter({}, fakeFetch({ 'agent-app': { WECOM_BOT_SECRET: 'super-secret-value' } }) as any, log);
    expect(log.log.mock.calls[0][0]).toContain('WECOM_BOT_SECRET');
    expect(log.log.mock.calls[0][0]).not.toContain('super-secret-value');
  });

  it('取不到时用本地配置继续；CONFIG_CENTER_REQUIRED=true 时启动失败；GATEWAY_ENABLED=false 时不读', async () => {
    const env: NodeJS.ProcessEnv = { WECOM_BOT_ID: 'local' };
    expect((await loadConfigCenter(env, fakeFetch({}, 503) as any, quiet)).status).toBe('unreachable');
    expect(env.WECOM_BOT_ID).toBe('local');
    await expect(loadConfigCenter({ CONFIG_CENTER_REQUIRED: 'true' }, fakeFetch({}, 401) as any, quiet)).rejects.toThrow('停止启动');
    const f = fakeFetch({});
    expect((await loadConfigCenter({ GATEWAY_ENABLED: 'false' }, f as any, quiet)).status).toBe('disabled');
    expect(f).not.toHaveBeenCalled();
  });

  it('黄勇 runtime 命名空间（流控助手写入的小驼峰键）映射成运行时的环境变量，同一参数以 runtime 为准', async () => {
    expect(mapRuntime({ quietWindowMs: 2500, micSeizeScope: 'CS_ONLY', unknownKey: 1 })).toEqual({ QUIET_WINDOW_MS: 2500, MIC_SEIZE_SCOPE: 'CS_ONLY' });
    const env: NodeJS.ProcessEnv = {};
    await loadConfigCenter(env, fakeFetch({ 'agent-app': { QUIET_WINDOW_MS: 3000 }, runtime: { quietWindowMs: 2500, humanWaitTimeoutMs: 90000 } }) as any, quiet);
    expect(env).toMatchObject({ QUIET_WINDOW_MS: '2500', HUMAN_WAIT_TIMEOUT_MS: '90000' });
  });
});
