import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { ManualController } from '../src/manual/manual.controller';
import { ManualService } from '../src/manual/manual.service';
import type { ApiCatalogResponse, ApiManualItem } from '../src/manual/manual.types';

describe('ManualModule (网关接口手册与启动自省服务)', () => {
  let moduleRef: TestingModule;
  let manualService: ManualService;
  let manualController: ManualController;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.forRoot({
          PORT: 3003,
          NODE_ENV: 'test',
          REDIS_HOST: 'localhost',
          REDIS_PORT: 6379,
        }),
      ],
    }).compile();

    // 触发 Nest 启动生命周期钩子，执行 onApplicationBootstrap 自省
    await moduleRef.init();

    manualService = moduleRef.get<ManualService>(ManualService);
    manualController = moduleRef.get<ManualController>(ManualController);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('服务启动后应成功收集对外接口并完成索引', () => {
    const catalog = manualService.getCatalog();
    expect(catalog).toBeDefined();
    expect(catalog.title).toContain('网关');
    expect(catalog.total).toBeGreaterThanOrEqual(14);
    expect(catalog.catalog.length).toBe(catalog.total);

    // 检查第 1 个条目是否包含基础字段
    const first = catalog.catalog[0];
    expect(first.index).toBe(1);
    expect(first.key).toBeDefined();
    expect(first.method).toBeDefined();
    expect(first.path).toBeDefined();
    expect(first.detailUrl).toBe(`/api/manual?index=${first.index}`);
  });

  it('GET /api (无参) 应返回接口目录清单', async () => {
    const res = await manualController.getRoot();
    expect(res.success).toBe(true);
    const catalog = res.data as ApiCatalogResponse;
    expect(catalog.total).toBeGreaterThanOrEqual(14);
    expect(catalog.catalog.some((c) => c.key === 'registry-register')).toBe(true);
    expect(catalog.catalog.some((c) => c.key === 'config-namespaces')).toBe(true);
    expect(catalog.catalog.some((c) => c.key === 'health-check')).toBe(true);
  });

  it('GET /api?index=1 应通过数字序号获取详细出入参说明', async () => {
    const res = await manualController.getRoot('1');
    expect(res.success).toBe(true);
    const item = res.data as ApiManualItem;
    expect(item.index).toBe(1);
    expect(item.name).toBeDefined();
    expect(item.method).toBeDefined();
    expect(item.path).toBeDefined();
    expect(item.inputs).toBeDefined();
    expect(item.outputs).toBeDefined();
    expect(item.outputs.statusCode).toBe(200);
    expect(item.outputs.fields.length).toBeGreaterThan(0);
    expect(item.curlExample).toBeDefined();
  });

  it('GET /api?index=registry-register 应通过 Key 索引获取注册接口用法', async () => {
    const res = await manualController.getRoot('registry-register');
    expect(res.success).toBe(true);
    const item = res.data as ApiManualItem;
    expect(item.key).toBe('registry-register');
    expect(item.name).toBe('注册服务实例');
    expect(item.inputs.body?.some((b) => b.name === 'instanceId')).toBe(true);
    expect(item.inputs.body?.some((b) => b.name === 'serviceName')).toBe(true);
  });

  it('GET /api?index=/api/registry/register 应通过路由路径索引获取用法', async () => {
    const res = await manualController.getRoot('/api/registry/register');
    expect(res.success).toBe(true);
    const item = res.data as ApiManualItem;
    expect(item.key).toBe('registry-register');
  });

  it('GET /api?index=health 应通过短名别名获取健康检查接口用法', async () => {
    const res = await manualController.getRoot('health');
    expect(res.success).toBe(true);
    const item = res.data as ApiManualItem;
    expect(item.key).toBe('health-check');
    expect(item.path).toBe('/health');
    expect(item.authRequired).toBe(false);
  });

  it('GET /api/manual/:index 路径参数化查询单接口用法', async () => {
    const res = await manualController.getManualByIndex('config-namespaces');
    expect(res.success).toBe(true);
    expect(res.data.key).toBe('config-namespaces');
    expect(res.data.name).toBe('列出所有命名空间');
    expect(res.data.method).toBe('GET');
  });

  it('查询未知索引时应抛出友好 NotFoundException (404)', async () => {
    await expect(manualController.getRoot('non-existent-endpoint-xyz-999')).rejects.toThrow(
      NotFoundException,
    );
  });
});
