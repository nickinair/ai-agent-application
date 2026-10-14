import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { RedisService } from '../infra/redis.service';
import type {
  HeartbeatDto,
  RegisterInstanceDto,
  RegistryEvent,
  ServiceInstance,
} from './registry.types';

/**
 * a3 专属服务注册与发现中心核心服务
 * 提供多实例注册、心跳租期刷新、服务发现查询与过期自愈。
 */
@Injectable()
export class RegistryService {
  private readonly logger = new Logger(RegistryService.name);

  /** 内存实例缓存（加速查询与独立运行时兜底） */
  private readonly memoryInstances = new Map<string, ServiceInstance>();

  /** 服务名到实例 ID 列表的反向索引 */
  private readonly memoryServiceIndex = new Map<string, Set<string>>();

  constructor(
    @Optional() @Inject(ENV) private readonly env?: Env,
    @Optional() private readonly redisService?: RedisService,
  ) {}

  /**
   * 注册服务实例
   */
  async register(dto: RegisterInstanceDto): Promise<ServiceInstance> {
    const now = Date.now();
    const ttlSeconds = dto.ttlSeconds ?? this.env?.REGISTRY_TTL_SECONDS ?? 30;

    const instance: ServiceInstance = {
      instanceId: dto.instanceId,
      serviceName: dto.serviceName,
      host: dto.host,
      port: dto.port,
      status: dto.status ?? 'UP',
      metadata: dto.metadata ?? {},
      registeredAt: now,
      lastHeartbeatAt: now,
      ttlSeconds,
    };

    // 1. 同步写入内存映射
    this.memoryInstances.set(instance.instanceId, instance);
    if (!this.memoryServiceIndex.has(instance.serviceName)) {
      this.memoryServiceIndex.set(instance.serviceName, new Set());
    }
    this.memoryServiceIndex.get(instance.serviceName)!.add(instance.instanceId);

    // 2. 同步持久化写入 Redis（若已连接）
    if (this.redisService) {
      const instanceKey = this.buildInstanceKey(instance.instanceId);
      const serviceSetKey = this.buildServiceSetKey(instance.serviceName);
      const allServicesKey = this.buildAllServicesKey();

      await this.redisService.set(instanceKey, JSON.stringify(instance), ttlSeconds);
      const client = this.redisService.getClient();
      await client.sadd(allServicesKey, instance.serviceName);
      await client.sadd(serviceSetKey, instance.instanceId);

      // 发送注册变更事件通知
      const event: RegistryEvent = {
        type: 'REGISTER',
        instanceId: instance.instanceId,
        serviceName: instance.serviceName,
        timestamp: now,
        data: instance,
      };
      await this.redisService.publish('a3:registry:events', JSON.stringify(event));
    }

    this.logger.log(
      `[服务注册] 实例 ${instance.instanceId} 已成功注册至服务 ${instance.serviceName} (${instance.host}:${instance.port}), 租约 TTL=${ttlSeconds}s`,
    );

    return instance;
  }

  /**
   * 心跳续约
   */
  async heartbeat(dto: HeartbeatDto): Promise<{ success: boolean; instance?: ServiceInstance }> {
    const now = Date.now();

    // 1. 检查内存缓存
    let instance = this.memoryInstances.get(dto.instanceId);

    // 2. 若内存未命中且 Redis 存在，则从 Redis 尝试载入
    if (!instance && this.redisService) {
      const instanceKey = this.buildInstanceKey(dto.instanceId);
      const raw = await this.redisService.get(instanceKey);
      if (raw) {
        try {
          instance = JSON.parse(raw) as ServiceInstance;
          this.memoryInstances.set(instance.instanceId, instance);
          if (!this.memoryServiceIndex.has(instance.serviceName)) {
            this.memoryServiceIndex.set(instance.serviceName, new Set());
          }
          this.memoryServiceIndex.get(instance.serviceName)!.add(instance.instanceId);
        } catch {
          // parse error
        }
      }
    }

    // 3. 实例不存在（可能已过期剔除），需重新注册
    if (!instance) {
      this.logger.warn(`[心跳续约拒绝] 实例 ${dto.instanceId} 不存在或租约已过期，需重新调用 register 接口`);
      return { success: false };
    }

    // 4. 更新实例时间戳及状态
    instance.lastHeartbeatAt = now;
    if (dto.status) {
      instance.status = dto.status;
    }

    // 5. 刷新 Redis 过期时间
    if (this.redisService) {
      const instanceKey = this.buildInstanceKey(instance.instanceId);
      await this.redisService.set(instanceKey, JSON.stringify(instance), instance.ttlSeconds);
    }

    this.logger.debug(`[心跳续约] 实例 ${dto.instanceId} 续约成功`);
    return { success: true, instance };
  }

  /**
   * 服务主动注销下线
   */
  async deregister(instanceId: string, serviceName?: string): Promise<boolean> {
    const instance = this.memoryInstances.get(instanceId);
    const resolvedServiceName = serviceName ?? instance?.serviceName;

    // 1. 移除内存
    this.memoryInstances.delete(instanceId);
    if (resolvedServiceName && this.memoryServiceIndex.has(resolvedServiceName)) {
      this.memoryServiceIndex.get(resolvedServiceName)!.delete(instanceId);
      if (this.memoryServiceIndex.get(resolvedServiceName)!.size === 0) {
        this.memoryServiceIndex.delete(resolvedServiceName);
      }
    }

    // 2. 移除 Redis
    if (this.redisService) {
      const instanceKey = this.buildInstanceKey(instanceId);
      await this.redisService.del(instanceKey);

      if (resolvedServiceName) {
        const serviceSetKey = this.buildServiceSetKey(resolvedServiceName);
        const client = this.redisService.getClient();
        await client.srem(serviceSetKey, instanceId);

        const count = await client.scard(serviceSetKey);
        if (count === 0) {
          await client.srem(this.buildAllServicesKey(), resolvedServiceName);
        }
      }

      // 发布注销事件
      const event: RegistryEvent = {
        type: 'DEREGISTER',
        instanceId,
        serviceName: resolvedServiceName ?? 'unknown',
        timestamp: Date.now(),
      };
      await this.redisService.publish('a3:registry:events', JSON.stringify(event));
    }

    this.logger.log(`[服务注销] 实例 ${instanceId} 已成功注销下线`);
    return true;
  }

  /**
   * 获取所有存活的服务列表
   */
  async getServices(): Promise<string[]> {
    await this.pruneExpired();

    if (this.redisService) {
      const client = this.redisService.getClient();
      const services = await client.smembers(this.buildAllServicesKey());
      return services.sort();
    }

    return Array.from(this.memoryServiceIndex.keys()).sort();
  }

  /**
   * 获取指定服务的所有健康实例列表
   */
  async getInstances(serviceName: string): Promise<ServiceInstance[]> {
    await this.pruneExpired();

    const result: ServiceInstance[] = [];

    if (this.redisService) {
      const client = this.redisService.getClient();
      const serviceSetKey = this.buildServiceSetKey(serviceName);
      const instanceIds = await client.smembers(serviceSetKey);

      for (const id of instanceIds) {
        const raw = await this.redisService.get(this.buildInstanceKey(id));
        if (raw) {
          try {
            const inst = JSON.parse(raw) as ServiceInstance;
            result.push(inst);
          } catch {
            // parse error
          }
        } else {
          // Redis key 已自然过期，移除 set 索引
          await client.srem(serviceSetKey, id);
        }
      }
      return result;
    }

    const ids = this.memoryServiceIndex.get(serviceName);
    if (!ids) return [];

    for (const id of ids) {
      const inst = this.memoryInstances.get(id);
      if (inst) result.push(inst);
    }

    return result;
  }

  /**
   * 获取指定实例详情
   */
  async getInstance(instanceId: string): Promise<ServiceInstance | null> {
    if (this.redisService) {
      const raw = await this.redisService.get(this.buildInstanceKey(instanceId));
      if (raw) {
        try {
          return JSON.parse(raw) as ServiceInstance;
        } catch {
          return null;
        }
      }
    }

    return this.memoryInstances.get(instanceId) ?? null;
  }

  /**
   * 清理过期未续约的实例（自愈机制）
   */
  async pruneExpired(): Promise<number> {
    const now = Date.now();
    let prunedCount = 0;

    for (const [id, inst] of this.memoryInstances.entries()) {
      const expireTime = inst.lastHeartbeatAt + inst.ttlSeconds * 1000;
      if (now > expireTime) {
        this.memoryInstances.delete(id);
        const set = this.memoryServiceIndex.get(inst.serviceName);
        if (set) {
          set.delete(id);
          if (set.size === 0) {
            this.memoryServiceIndex.delete(inst.serviceName);
          }
        }
        prunedCount++;
        this.logger.warn(`[租约过期剔除] 实例 ${id} 超时未心跳，已被自动下线`);
      }
    }

    return prunedCount;
  }

  private buildInstanceKey(instanceId: string): string {
    return `a3:registry:instances:${instanceId}`;
  }

  private buildServiceSetKey(serviceName: string): string {
    return `a3:registry:service_instances:${serviceName}`;
  }

  private buildAllServicesKey(): string {
    return 'a3:registry:services';
  }
}
