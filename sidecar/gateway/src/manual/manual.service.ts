import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
  RequestMethod,
} from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import type {
  ApiCatalogEntry,
  ApiCatalogResponse,
  ApiManualItem,
} from './manual.types';
import { API_MANUAL_SPECS } from './manual-specs.data';

@Injectable()
export class ManualService implements OnApplicationBootstrap {
  private readonly logger = new Logger('ManualService');
  private items: ApiManualItem[] = [];
  private readonly indexMap = new Map<string, ApiManualItem>();

  constructor(
    @Optional() private readonly discoveryService?: DiscoveryService,
    @Optional() private readonly metadataScanner?: MetadataScanner,
  ) {}

  /**
   * 服务启动时生命周期钩子：自动收集与索引全部对外接口
   */
  async onApplicationBootstrap(): Promise<void> {
    this.collectAndIndexEndpoints();
  }

  /**
   * 收集控制器路由并与规范注册表深度整合
   */
  public collectAndIndexEndpoints(): void {
    const discoveredRoutes: Array<{ method: string; path: string }> = [];

    if (this.discoveryService) {
      const controllers = this.discoveryService.getControllers();
      for (const wrapper of controllers) {
        const { instance, metatype } = wrapper;
        if (!instance || !metatype) continue;

        const controllerPath = Reflect.getMetadata('path', metatype) || '';
        const prototype = Object.getPrototypeOf(instance);
        const methodNames = Object.getOwnPropertyNames(prototype).filter(
          (m) => m !== 'constructor' && typeof instance[m] === 'function',
        );

        for (const methodName of methodNames) {
          const handler = instance[methodName];
          const methodPath = Reflect.getMetadata('path', handler);
          const requestMethodCode = Reflect.getMetadata('method', handler);

          if (requestMethodCode !== undefined) {
            const httpMethod = RequestMethod[requestMethodCode] || 'GET';
            const cleanController = typeof controllerPath === 'string'
              ? controllerPath.replace(/^\/+|\/+$/g, '')
              : '';
            const cleanMethod = typeof methodPath === 'string'
              ? methodPath.replace(/^\/+|\/+$/g, '')
              : '';

            const combined = [cleanController, cleanMethod].filter(Boolean).join('/');
            const fullPath = '/' + combined;

            discoveredRoutes.push({ method: httpMethod, path: fullPath });
          }
        }
      }
    }

    // 整合 API_MANUAL_SPECS 与动态发现的路由
    const mergedList: ApiManualItem[] = [];
    const assignedPaths = new Set<string>();

    // 1. 首先加载预定义的详细规范（确保出入参完整且排版优雅）
    for (const spec of API_MANUAL_SPECS) {
      const routeKey = `${spec.method.toUpperCase()} ${this.normalizeRoute(spec.path)}`;
      assignedPaths.add(routeKey);
      mergedList.push({
        ...spec,
        index: 0, // 稍后统一赋序
      });
    }

    // 注册 GET /api/manual 作为 GET /api 的并行业务别名
    assignedPaths.add('GET /api/manual');

    // 2. 将动态发现但未显式列入 spec 的新路由自动追加（自省兜底机制）
    for (const route of discoveredRoutes) {
      const routeKey = `${route.method.toUpperCase()} ${this.normalizeRoute(route.path)}`;
      if (!assignedPaths.has(routeKey)) {
        assignedPaths.add(routeKey);

        // 自动提取路径中的 :param 参数
        const paramMatches = route.path.match(/:([a-zA-Z0-9_]+)/g) || [];
        const pathParams = paramMatches.map((p) => ({
          name: p.slice(1),
          type: 'string',
          required: true,
          description: `动态路径参数: ${p}`,
        }));

        mergedList.push({
          index: 0,
          key: `auto-${route.method.toLowerCase()}-${route.path.replace(/[^a-zA-Z0-9]/g, '-')}`,
          name: `动态路由: ${route.method} ${route.path}`,
          category: '动态自省接口',
          method: route.method,
          path: route.path,
          authRequired: false,
          description: `服务启动自省收集到的对外接口: ${route.method} ${route.path}`,
          inputs: {
            headers: [],
            params: pathParams,
            query: [],
            body: [],
          },
          outputs: {
            statusCode: 200,
            description: '操作成功',
            fields: [],
            example: { success: true },
          },
          curlExample: `curl -X ${route.method} http://localhost:3003${route.path}`,
        });
      }
    }

    // 3. 按照分类与顺序建立 1 开始的连续序号
    mergedList.sort((a, b) => {
      const catOrder: Record<string, number> = {
        '服务注册与发现中心 (SRF)': 1,
        '动态配置中心 (CC)': 2,
        '健康探针': 3,
        '网关手册中心': 4,
      };
      const orderA = catOrder[a.category] || 99;
      const orderB = catOrder[b.category] || 99;
      if (orderA !== orderB) return orderA - orderB;
      return a.path.localeCompare(b.path);
    });

    this.items = mergedList.map((item, idx) => ({
      ...item,
      index: idx + 1,
    }));

    // 4. 构建快速多维索引映射表
    this.indexMap.clear();
    for (const item of this.items) {
      // 序号索引: "1", "2"
      this.indexMap.set(String(item.index), item);
      // Key 索引: "registry-register"
      this.indexMap.set(item.key.toLowerCase(), item);
      // 路径索引: "/api/registry/register" 或 "api/registry/register"
      this.indexMap.set(item.path.toLowerCase(), item);
      this.indexMap.set(this.normalizeRoute(item.path).toLowerCase(), item);
      // 方法+路径索引: "post /api/registry/register"
      this.indexMap.set(`${item.method.toLowerCase()} ${item.path.toLowerCase()}`, item);

      // 短名别名索引（如 "register", "heartbeat", "services", "namespaces", "health", "manual"）
      const slug = item.key.split('-').pop();
      if (slug && !this.indexMap.has(slug)) {
        this.indexMap.set(slug.toLowerCase(), item);
      }
    }

    this.logger.log(
      `📖 [网关手册] 服务启动自省完成: 成功收集并索引 ${this.items.length} 个对外 HTTP 接口`,
    );
  }

  /**
   * 获取所有接口目录清单
   */
  public getCatalog(): ApiCatalogResponse {
    const catalog: ApiCatalogEntry[] = this.items.map((item) => ({
      index: item.index,
      key: item.key,
      method: item.method,
      path: item.path,
      category: item.category,
      summary: item.name,
      authRequired: item.authRequired,
      detailUrl: `/api/manual?index=${item.index}`,
    }));

    return {
      title: 'a3 专属内部微服务网关 (Sidecar Gateway) 接口手册',
      version: '1.0.0',
      total: catalog.length,
      usageTip:
        '通过索引参数获取详细用法，例如: curl http://localhost:3003/api?index=1 或 curl http://localhost:3003/api/manual?index=register',
      catalog,
    };
  }

  /**
   * 根据索引参数（数字序号、Key、或路径）查询接口详细出入参说明
   */
  public getItemByIndex(indexOrQuery?: string | number): ApiManualItem | null {
    if (indexOrQuery === undefined || indexOrQuery === null) {
      return null;
    }

    const q = String(indexOrQuery).trim().toLowerCase();
    if (!q) return null;

    // 1. 精确匹配（序号 / Key / 路径）
    if (this.indexMap.has(q)) {
      return this.indexMap.get(q)!;
    }

    // 2. 去除前导斜杠后再查
    const noLeadingSlash = q.replace(/^\/+/, '');
    if (this.indexMap.has(noLeadingSlash)) {
      return this.indexMap.get(noLeadingSlash)!;
    }

    // 3. 尝试模糊查找 path 或 key 包含关键词的项
    for (const item of this.items) {
      if (
        item.key.toLowerCase().includes(q) ||
        item.path.toLowerCase().includes(q) ||
        item.name.toLowerCase().includes(q)
      ) {
        return item;
      }
    }

    return null;
  }

  /**
   * 获取所有索引条目列表
   */
  public getAllItems(): ApiManualItem[] {
    return this.items;
  }

  /**
   * 规范化路由路径，便于比对
   */
  private normalizeRoute(route: string): string {
    return route.replace(/\/+/g, '/').replace(/\/$/, '');
  }
}
