/**
 * 单项配置项结构
 */
export interface ConfigItem<T = unknown> {
  /** 命名空间 (如 default, tenant_1, wecom, llm) */
  namespace: string;
  /** 配置键名 */
  key: string;
  /** 配置值 (任意 JSON 兼容值) */
  value: T;
  /** 配置版本号 (自增) */
  version: number;
  /** 最后修改时间戳 (ms) */
  updatedAt: number;
  /** 备注说明 */
  comment?: string;
}

/**
 * 设置配置 DTO
 */
export interface SetConfigDto<T = unknown> {
  key: string;
  value: T;
  comment?: string;
}

/**
 * 批量设置配置 DTO
 */
export interface BatchSetConfigDto {
  configs: Record<string, unknown>;
  comment?: string;
}

/**
 * 配置变更通知事件（广播至 Redis Channel: ag:cfg:changed）
 */
export interface ConfigChangeEvent {
  namespace: string;
  key?: string;
  version: number;
  timestamp: number;
}
