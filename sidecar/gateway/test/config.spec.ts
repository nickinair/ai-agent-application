import { ConfigService } from '../src/config-center/config.service';

describe('ConfigService', () => {
  let service: ConfigService;

  beforeEach(() => {
    service = new ConfigService({
      PORT: 3003,
      NODE_ENV: 'test',
      REDIS_HOST: 'localhost',
      REDIS_PORT: 6379,
      REDIS_DB: 0,
      REGISTRY_TTL_SECONDS: 30,
      IDENTITY_FETCH_TIMEOUT_MS: 300,
      IDENTITY_CACHE_TTL_SECONDS: 3600,
    });
  });

  it('设置与读取配置项应正常工作，且版本号自增', async () => {
    const item1 = await service.set('wecom', 'bot_ws_enabled', true, '开启长连接');
    expect(item1.version).toBe(1);
    expect(item1.value).toBe(true);

    const fetched1 = await service.get<boolean>('wecom', 'bot_ws_enabled');
    expect(fetched1?.value).toBe(true);
    expect(fetched1?.version).toBe(1);

    // 再次更新，版本号递增
    const item2 = await service.set('wecom', 'bot_ws_enabled', false, '关闭长连接');
    expect(item2.version).toBe(2);
    expect(item2.value).toBe(false);

    const fetched2 = await service.get<boolean>('wecom', 'bot_ws_enabled');
    expect(fetched2?.value).toBe(false);
    expect(fetched2?.version).toBe(2);
  });

  it('查询不存在的配置项应返回 null', async () => {
    const res = await service.get('unknown-ns', 'unknown-key');
    expect(res).toBeNull();
  });

  it('批量设置与全量读取命名空间配置应一致', async () => {
    await service.batchSet('tenant_1', {
      mic_timeout_seconds: 60,
      buffer_quiet_seconds: 3,
      model_route: 'qwen-max',
    });

    const all = await service.getAll('tenant_1');
    expect(all).toEqual({
      mic_timeout_seconds: 60,
      buffer_quiet_seconds: 3,
      model_route: 'qwen-max',
    });
  });

  it('删除配置项应成功并从字典移除', async () => {
    await service.set('llm', 'temp_key', 'temp_val');
    expect(await service.get('llm', 'temp_key')).not.toBeNull();

    const deleted = await service.delete('llm', 'temp_key');
    expect(deleted).toBe(true);

    const after = await service.get('llm', 'temp_key');
    expect(after).toBeNull();
  });

  it('列出命名空间清单应包含已写入的命名空间', async () => {
    await service.set('ns_alpha', 'k1', 1);
    await service.set('ns_beta', 'k2', 2);

    const namespaces = await service.listNamespaces();
    expect(namespaces).toContain('ns_alpha');
    expect(namespaces).toContain('ns_beta');
  });
});
