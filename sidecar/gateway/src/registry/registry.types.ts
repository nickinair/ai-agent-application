/**
 * 服务实例健康状态
 */
export type ServiceHealthStatus = 'UP' | 'DOWN' | 'STARTING' | 'OUT_OF_SERVICE';

/**
 * 内部注册的服务实例详情
 */
export interface ServiceInstance {
  /** 实例唯一标识 (如 a3-core-node-1, wecom-finance-1) */
  instanceId: string;
  /** 服务名称 (如 ai-agent-application, wecom-finance) */
  serviceName: string;
  /** 服务主机 IP 或网络别名 */
  host: string;
  /** 服务监听端口 */
  port: number;
  /** 当前健康状态 */
  status: ServiceHealthStatus;
  /** 扩展元数据 (如权重、环境、Git 提交等) */
  metadata?: Record<string, unknown>;
  /** 注册时间戳 (ms) */
  registeredAt: number;
  /** 最近一次心跳时间戳 (ms) */
  lastHeartbeatAt: number;
  /** 心跳租约时长 (秒，默认 30s) */
  ttlSeconds: number;
}

/**
 * 服务注册请求 DTO
 */
export interface RegisterInstanceDto {
  instanceId: string;
  serviceName: string;
  host: string;
  port: number;
  status?: ServiceHealthStatus;
  metadata?: Record<string, unknown>;
  ttlSeconds?: number;
}

/**
 * 心跳续约请求 DTO
 */
export interface HeartbeatDto {
  instanceId: string;
  serviceName?: string;
  status?: ServiceHealthStatus;
}

/**
 * 服务注册事件广播结构
 */
export interface RegistryEvent {
  type: 'REGISTER' | 'HEARTBEAT' | 'DEREGISTER' | 'EXPIRE';
  instanceId: string;
  serviceName: string;
  timestamp: number;
  data?: Partial<ServiceInstance>;
}
