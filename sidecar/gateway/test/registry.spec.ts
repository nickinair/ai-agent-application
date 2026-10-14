import { RegistryService } from '../src/registry/registry.service';
import type { RegisterInstanceDto } from '../src/registry/registry.types';

describe('RegistryService', () => {
  let service: RegistryService;

  beforeEach(() => {
    service = new RegistryService({
      PORT: 3003,
      NODE_ENV: 'test',
      REDIS_HOST: 'localhost',
      REDIS_PORT: 6379,
      REDIS_DB: 0,
      REGISTRY_TTL_SECONDS: 2, // 2s 用于测试快速过期
      IDENTITY_FETCH_TIMEOUT_MS: 300,
      IDENTITY_CACHE_TTL_SECONDS: 3600,
    });
  });

  it('应该成功注册新服务实例并能查到', async () => {
    const dto: RegisterInstanceDto = {
      instanceId: 'a3-node-1',
      serviceName: 'ai-agent-application',
      host: '127.0.0.1',
      port: 3002,
      metadata: { env: 'test', version: '0.1.0' },
    };

    const inst = await service.register(dto);
    expect(inst.instanceId).toBe('a3-node-1');
    expect(inst.serviceName).toBe('ai-agent-application');
    expect(inst.status).toBe('UP');

    const services = await service.getServices();
    expect(services).toContain('ai-agent-application');

    const instances = await service.getInstances('ai-agent-application');
    expect(instances).toHaveLength(1);
    expect(instances[0].instanceId).toBe('a3-node-1');

    const single = await service.getInstance('a3-node-1');
    expect(single).not.toBeNull();
    expect(single?.port).toBe(3002);
  });

  it('心跳续约应更新最后心跳时间戳与状态', async () => {
    await service.register({
      instanceId: 'wecom-finance-1',
      serviceName: 'wecom-finance',
      host: '127.0.0.1',
      port: 3005,
    });

    const initial = await service.getInstance('wecom-finance-1');
    const initialHeartbeat = initial!.lastHeartbeatAt;

    // 模拟等待 10ms
    await new Promise((resolve) => setTimeout(resolve, 15));

    const hbRes = await service.heartbeat({
      instanceId: 'wecom-finance-1',
      status: 'UP',
    });

    expect(hbRes.success).toBe(true);
    expect(hbRes.instance?.lastHeartbeatAt).toBeGreaterThan(initialHeartbeat);
  });

  it('对不存在的实例发送心跳应返回失败', async () => {
    const hbRes = await service.heartbeat({ instanceId: 'non-existent-instance' });
    expect(hbRes.success).toBe(false);
  });

  it('主动注销下线应从实例列表与服务列表移除', async () => {
    await service.register({
      instanceId: 'temp-inst-1',
      serviceName: 'temp-service',
      host: '127.0.0.1',
      port: 9999,
    });

    expect(await service.getServices()).toContain('temp-service');

    const deregRes = await service.deregister('temp-inst-1', 'temp-service');
    expect(deregRes).toBe(true);

    const instances = await service.getInstances('temp-service');
    expect(instances).toHaveLength(0);

    const services = await service.getServices();
    expect(services).not.toContain('temp-service');
  });

  it('超期未心跳实例应被自动剔除自愈', async () => {
    await service.register({
      instanceId: 'expiring-node-1',
      serviceName: 'expiring-service',
      host: '127.0.0.1',
      port: 8888,
      ttlSeconds: 0.05, // 50ms 极短租约
    });

    // 立即查询存在
    expect(await service.getInstances('expiring-service')).toHaveLength(1);

    // 等待 70ms 触发过期
    await new Promise((resolve) => setTimeout(resolve, 70));

    const instances = await service.getInstances('expiring-service');
    expect(instances).toHaveLength(0);
  });
});
