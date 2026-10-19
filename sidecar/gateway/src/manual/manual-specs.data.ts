import type { ApiManualItem } from './manual.types';

/**
 * 网关对外接口全量规范定义表
 * 包含 SRF 服务注册与发现中心、CC 动态配置中心、健康探针以及手册自省接口。
 * 字段严格与 sidecar/gateway/doc/API.md 对齐。
 */
export const API_MANUAL_SPECS: Omit<ApiManualItem, 'index'>[] = [
  // --------------------------------------------------------------------------
  // 1. 服务注册与发现中心 (SRF)
  // --------------------------------------------------------------------------
  {
    key: 'registry-register',
    name: '注册服务实例',
    category: '服务注册与发现中心 (SRF)',
    method: 'POST',
    path: '/api/registry/register',
    authRequired: true,
    description: '微服务组件启动时向网关注册实例标识、服务名、IP、端口及元数据，启动 TTL 存活租期。',
    inputs: {
      headers: [
        { name: 'Content-Type', type: 'string', required: true, default: 'application/json', description: '请求体数据格式' },
        { name: 'x-gateway-token', type: 'string', required: false, description: '网关鉴权令牌（若网关配置了 GATEWAY_AUTH_TOKEN）' },
      ],
      params: [],
      query: [],
      body: [
        { name: 'instanceId', type: 'string', required: true, description: '实例唯一标识', example: 'a3-node-1' },
        { name: 'serviceName', type: 'string', required: true, description: '服务逻辑名称', example: 'ai-agent-application' },
        { name: 'host', type: 'string', required: true, description: '服务所在 IP 或可达主机名', example: '127.0.0.1' },
        { name: 'port', type: 'number', required: true, description: '服务监听端口', example: 3002 },
        { name: 'metadata', type: 'object', required: false, description: '自定义元数据字典', example: { version: '1.0.0', webhookPath: '/api/admin/wecom/finance-inbound' } },
        { name: 'ttlSeconds', type: 'number', required: false, default: 30, description: '租期存活秒数（默认 30s）', example: 30 },
      ],
    },
    outputs: {
      statusCode: 200,
      description: '实例注册成功，返回完整的服务实例信息',
      fields: [
        { name: 'success', type: 'boolean', description: '操作状态' },
        { name: 'data.instanceId', type: 'string', description: '实例唯一标识' },
        { name: 'data.serviceName', type: 'string', description: '服务逻辑名称' },
        { name: 'data.host', type: 'string', description: '服务 IP 地址' },
        { name: 'data.port', type: 'number', description: '服务端口' },
        { name: 'data.status', type: 'string', description: '服务状态 (UP/DOWN)' },
        { name: 'data.registeredAt', type: 'number', description: '注册时间戳 (毫秒)' },
        { name: 'data.lastHeartbeatAt', type: 'number', description: '最后心跳时间戳 (毫秒)' },
        { name: 'data.ttlSeconds', type: 'number', description: '租期时长 (秒)' },
      ],
      example: {
        success: true,
        data: {
          instanceId: 'a3-node-1',
          serviceName: 'ai-agent-application',
          host: '127.0.0.1',
          port: 3002,
          metadata: { version: '1.0.0', webhookPath: '/api/admin/wecom/finance-inbound' },
          registeredAt: 1792389000000,
          lastHeartbeatAt: 1792389000000,
          ttlSeconds: 30,
          status: 'UP',
        },
      },
      errorResponses: [
        { statusCode: 400, description: '请求体字段缺失或格式错误' },
        { statusCode: 401, description: '未携带或携带无效的 GATEWAY_AUTH_TOKEN' },
      ],
    },
    curlExample: `curl -X POST http://localhost:3003/api/registry/register \\
  -H "Content-Type: application/json" \\
  -d '{"instanceId":"a3-node-1","serviceName":"ai-agent-application","host":"127.0.0.1","port":3002}'`,
  },
  {
    key: 'registry-heartbeat',
    name: '心跳续约保活',
    category: '服务注册与发现中心 (SRF)',
    method: 'POST',
    path: '/api/registry/heartbeat',
    authRequired: true,
    description: '服务实例定期发送心跳以刷新租期。若实例由于超时已被剔除，接口将返回失败，客户端应感知并触发重新注册。',
    inputs: {
      headers: [
        { name: 'Content-Type', type: 'string', required: true, default: 'application/json', description: '请求体数据格式' },
        { name: 'x-gateway-token', type: 'string', required: false, description: '网关鉴权令牌' },
      ],
      params: [],
      query: [],
      body: [
        { name: 'instanceId', type: 'string', required: true, description: '注册时的实例唯一标识', example: 'a3-node-1' },
        { name: 'serviceName', type: 'string', required: false, description: '服务名称（可选，辅助校验）', example: 'ai-agent-application' },
      ],
    },
    outputs: {
      statusCode: 200,
      description: '心跳续约成功',
      fields: [
        { name: 'success', type: 'boolean', description: '续约是否成功' },
        { name: 'data.instanceId', type: 'string', description: '实例 ID' },
        { name: 'data.lastHeartbeatAt', type: 'number', description: '更新后的心跳时间戳' },
        { name: 'data.status', type: 'string', description: '当前状态 (UP)' },
      ],
      example: {
        success: true,
        data: {
          instanceId: 'a3-node-1',
          serviceName: 'ai-agent-application',
          lastHeartbeatAt: 1792389010000,
          status: 'UP',
        },
      },
    },
    curlExample: `curl -X POST http://localhost:3003/api/registry/heartbeat \\
  -H "Content-Type: application/json" \\
  -d '{"instanceId":"a3-node-1","serviceName":"ai-agent-application"}'`,
  },
  {
    key: 'registry-deregister',
    name: '主动注销服务实例',
    category: '服务注册与发现中心 (SRF)',
    method: 'POST',
    path: '/api/registry/deregister',
    authRequired: true,
    description: '服务实例在收到停机信号（SIGTERM/SIGINT）时主动从网关服务注册中心剔除，避免流量打入正在退出的容器。',
    inputs: {
      headers: [
        { name: 'Content-Type', type: 'string', required: true, default: 'application/json', description: '请求体数据格式' },
        { name: 'x-gateway-token', type: 'string', required: false, description: '网关鉴权令牌' },
      ],
      params: [],
      query: [],
      body: [
        { name: 'instanceId', type: 'string', required: true, description: '待注销的实例唯一标识', example: 'a3-node-1' },
        { name: 'serviceName', type: 'string', required: false, description: '所属服务名称（可选）', example: 'ai-agent-application' },
      ],
    },
    outputs: {
      statusCode: 200,
      description: '注销操作完成',
      fields: [
        { name: 'success', type: 'boolean', description: '注销成功与否' },
      ],
      example: {
        success: true,
      },
    },
    curlExample: `curl -X POST http://localhost:3003/api/registry/deregister \\
  -H "Content-Type: application/json" \\
  -d '{"instanceId":"a3-node-1"}'`,
  },
  {
    key: 'registry-services',
    name: '查询所有存活服务名',
    category: '服务注册与发现中心 (SRF)',
    method: 'GET',
    path: '/api/registry/services',
    authRequired: true,
    description: '获取当前在网关中注册且仍存活的全部微服务名称列表。',
    inputs: {
      headers: [
        { name: 'x-gateway-token', type: 'string', required: false, description: '网关鉴权令牌' },
      ],
      params: [],
      query: [],
      body: [],
    },
    outputs: {
      statusCode: 200,
      description: '存活服务名称数组',
      fields: [
        { name: 'success', type: 'boolean', description: '请求状态' },
        { name: 'data', type: 'string[]', description: '服务名列表' },
      ],
      example: {
        success: true,
        data: ['ai-agent-application', 'wecom-finance'],
      },
    },
    curlExample: 'curl http://localhost:3003/api/registry/services',
  },
  {
    key: 'registry-instances-by-service',
    name: '查询指定服务健康实例',
    category: '服务注册与发现中心 (SRF)',
    method: 'GET',
    path: '/api/registry/instances/:serviceName',
    authRequired: true,
    description: '根据服务名查询当前所有处于 UP 状态的健康实例列表，可用于客户端负载均衡。',
    inputs: {
      headers: [
        { name: 'x-gateway-token', type: 'string', required: false, description: '网关鉴权令牌' },
      ],
      params: [
        { name: 'serviceName', type: 'string', required: true, description: '服务逻辑名称', example: 'ai-agent-application' },
      ],
      query: [],
      body: [],
    },
    outputs: {
      statusCode: 200,
      description: '健康实例列表',
      fields: [
        { name: 'success', type: 'boolean', description: '请求状态' },
        { name: 'data', type: 'ServiceInstance[]', description: '实例对象数组' },
      ],
      example: {
        success: true,
        data: [
          {
            instanceId: 'a3-node-1',
            serviceName: 'ai-agent-application',
            host: '127.0.0.1',
            port: 3002,
            status: 'UP',
            metadata: { version: '1.0.0' },
          },
        ],
      },
    },
    curlExample: 'curl http://localhost:3003/api/registry/instances/ai-agent-application',
  },
  {
    key: 'registry-instance-by-id',
    name: '查询单实例详情',
    category: '服务注册与发现中心 (SRF)',
    method: 'GET',
    path: '/api/registry/instance/:instanceId',
    authRequired: true,
    description: '根据实例唯一 ID 查询该实例的当前详细信息及元数据。',
    inputs: {
      headers: [
        { name: 'x-gateway-token', type: 'string', required: false, description: '网关鉴权令牌' },
      ],
      params: [
        { name: 'instanceId', type: 'string', required: true, description: '实例唯一标识', example: 'a3-node-1' },
      ],
      query: [],
      body: [],
    },
    outputs: {
      statusCode: 200,
      description: '实例详情对象',
      fields: [
        { name: 'success', type: 'boolean', description: '请求状态' },
        { name: 'data', type: 'ServiceInstance', description: '实例详情' },
      ],
      example: {
        success: true,
        data: {
          instanceId: 'a3-node-1',
          serviceName: 'ai-agent-application',
          host: '127.0.0.1',
          port: 3002,
          status: 'UP',
        },
      },
      errorResponses: [
        { statusCode: 404, description: '实例不存在或已过期下线' },
      ],
    },
    curlExample: 'curl http://localhost:3003/api/registry/instance/a3-node-1',
  },

  // --------------------------------------------------------------------------
  // 2. 动态配置中心 (CC)
  // --------------------------------------------------------------------------
  {
    key: 'config-namespaces',
    name: '列出所有命名空间',
    category: '动态配置中心 (CC)',
    method: 'GET',
    path: '/api/config/namespaces',
    authRequired: true,
    description: '列出当前配置中心中存在的所有命名空间列表（例如 wecom, llm, tenant_1 等）。',
    inputs: {
      headers: [
        { name: 'x-gateway-token', type: 'string', required: false, description: '网关鉴权令牌' },
      ],
      params: [],
      query: [],
      body: [],
    },
    outputs: {
      statusCode: 200,
      description: '命名空间名称列表',
      fields: [
        { name: 'success', type: 'boolean', description: '请求状态' },
        { name: 'data', type: 'string[]', description: '命名空间数组' },
      ],
      example: {
        success: true,
        data: ['wecom', 'tenant_1', 'system'],
      },
    },
    curlExample: 'curl http://localhost:3003/api/config/namespaces',
  },
  {
    key: 'config-get-all',
    name: '查询命名空间配置',
    category: '动态配置中心 (CC)',
    method: 'GET',
    path: '/api/config/:namespace',
    authRequired: true,
    description: '拉取指定命名空间下的完整配置字典，支持 ?detail=true 携带版本与修改时间戳元数据。',
    inputs: {
      headers: [
        { name: 'x-gateway-token', type: 'string', required: false, description: '网关鉴权令牌' },
      ],
      params: [
        { name: 'namespace', type: 'string', required: true, description: '命名空间名称', example: 'wecom' },
      ],
      query: [
        { name: 'detail', type: 'boolean | string', required: false, default: false, description: '是否返回包含 version, updatedAt, comment 的详细元数据字典', example: 'true' },
      ],
      body: [],
    },
    outputs: {
      statusCode: 200,
      description: '配置字典对象',
      fields: [
        { name: 'success', type: 'boolean', description: '请求状态' },
        { name: 'data', type: 'Record<string, unknown>', description: '配置键值对映射' },
      ],
      example: {
        success: true,
        data: {
          bot_ws_enabled: true,
          pollIntervalMs: 5000,
        },
      },
    },
    curlExample: 'curl "http://localhost:3003/api/config/wecom?detail=true"',
  },
  {
    key: 'config-get-key',
    name: '获取单个配置项',
    category: '动态配置中心 (CC)',
    method: 'GET',
    path: '/api/config/:namespace/:key',
    authRequired: true,
    description: '查询指定命名空间下的单条配置项完整信息（含 value, version, updatedAt, comment 等）。',
    inputs: {
      headers: [
        { name: 'x-gateway-token', type: 'string', required: false, description: '网关鉴权令牌' },
      ],
      params: [
        { name: 'namespace', type: 'string', required: true, description: '命名空间名称', example: 'wecom' },
        { name: 'key', type: 'string', required: true, description: '配置项键名', example: 'bot_ws_enabled' },
      ],
      query: [],
      body: [],
    },
    outputs: {
      statusCode: 200,
      description: '配置项详情对象',
      fields: [
        { name: 'success', type: 'boolean', description: '请求状态' },
        { name: 'data.key', type: 'string', description: '配置键名' },
        { name: 'data.value', type: 'any', description: '配置值' },
        { name: 'data.version', type: 'number', description: '版本号' },
        { name: 'data.updatedAt', type: 'number', description: '更新时间戳' },
        { name: 'data.comment', type: 'string', description: '更新备注' },
      ],
      example: {
        success: true,
        data: {
          key: 'bot_ws_enabled',
          value: true,
          version: 1,
          updatedAt: 1792389000000,
          comment: '开启企微机器人长连接',
        },
      },
      errorResponses: [
        { statusCode: 404, description: '配置项不存在' },
      ],
    },
    curlExample: 'curl http://localhost:3003/api/config/wecom/bot_ws_enabled',
  },
  {
    key: 'config-set',
    name: '设置/更新单项配置',
    category: '动态配置中心 (CC)',
    method: 'POST',
    path: '/api/config/:namespace',
    authRequired: true,
    description: '新增或修改单个配置项，自动递增版本号，并通过 Redis Pub/Sub 广播变更通知。',
    inputs: {
      headers: [
        { name: 'Content-Type', type: 'string', required: true, default: 'application/json', description: '请求体格式' },
        { name: 'x-gateway-token', type: 'string', required: false, description: '网关鉴权令牌' },
      ],
      params: [
        { name: 'namespace', type: 'string', required: true, description: '命名空间名称', example: 'wecom' },
      ],
      query: [],
      body: [
        { name: 'key', type: 'string', required: true, description: '配置项键名', example: 'pollIntervalMs' },
        { name: 'value', type: 'any', required: true, description: '配置项值（支持基本类型及复杂 JSON）', example: 5000 },
        { name: 'comment', type: 'string', required: false, description: '变更备注说明', example: '调整轮询时间' },
      ],
    },
    outputs: {
      statusCode: 200,
      description: '更新成功，返回保存的配置元数据',
      fields: [
        { name: 'success', type: 'boolean', description: '操作状态' },
        { name: 'data', type: 'ConfigItem', description: '配置对象' },
      ],
      example: {
        success: true,
        data: {
          key: 'pollIntervalMs',
          value: 5000,
          version: 2,
          updatedAt: 1792389020000,
          comment: '调整轮询时间',
        },
      },
    },
    curlExample: `curl -X POST http://localhost:3003/api/config/wecom \\
  -H "Content-Type: application/json" \\
  -d '{"key":"pollIntervalMs","value":5000,"comment":"调整轮询时间"}'`,
  },
  {
    key: 'config-batch-set',
    name: '批量导入/更新配置',
    category: '动态配置中心 (CC)',
    method: 'POST',
    path: '/api/config/:namespace/batch',
    authRequired: true,
    description: '批量导入或更新指定命名空间下的多个配置项。',
    inputs: {
      headers: [
        { name: 'Content-Type', type: 'string', required: true, default: 'application/json', description: '请求体格式' },
        { name: 'x-gateway-token', type: 'string', required: false, description: '网关鉴权令牌' },
      ],
      params: [
        { name: 'namespace', type: 'string', required: true, description: '命名空间名称', example: 'wecom' },
      ],
      query: [],
      body: [
        { name: 'configs', type: 'Record<string, any>', required: true, description: '键值对字典', example: { k1: 'v1', k2: 100 } },
        { name: 'comment', type: 'string', required: false, description: '批量变更备注', example: '初始化系统参数' },
      ],
    },
    outputs: {
      statusCode: 200,
      description: '批量操作完成',
      fields: [
        { name: 'success', type: 'boolean', description: '操作状态' },
        { name: 'data', type: 'Record<string, unknown>', description: '更新后的配置键值字典' },
      ],
      example: {
        success: true,
        data: {
          k1: 'v1',
          k2: 100,
        },
      },
    },
    curlExample: `curl -X POST http://localhost:3003/api/config/wecom/batch \\
  -H "Content-Type: application/json" \\
  -d '{"configs":{"k1":"v1","k2":100}}'`,
  },
  {
    key: 'config-delete-key',
    name: '删除单个配置项',
    category: '动态配置中心 (CC)',
    method: 'DELETE',
    path: '/api/config/:namespace/:key',
    authRequired: true,
    description: '从指定命名空间中永久移除特定配置项，并通过 Redis 发布删除通知。',
    inputs: {
      headers: [
        { name: 'x-gateway-token', type: 'string', required: false, description: '网关鉴权令牌' },
      ],
      params: [
        { name: 'namespace', type: 'string', required: true, description: '命名空间名称', example: 'wecom' },
        { name: 'key', type: 'string', required: true, description: '待删除的配置项键名', example: 'temp_key' },
      ],
      query: [],
      body: [],
    },
    outputs: {
      statusCode: 200,
      description: '删除操作完成',
      fields: [
        { name: 'success', type: 'boolean', description: '是否成功删除' },
      ],
      example: {
        success: true,
      },
    },
    curlExample: 'curl -X DELETE http://localhost:3003/api/config/wecom/temp_key',
  },
  {
    key: 'config-delete-namespace',
    name: '清空整个命名空间',
    category: '动态配置中心 (CC)',
    method: 'DELETE',
    path: '/api/config/:namespace',
    authRequired: true,
    description: '清空指定命名空间下的所有配置，并将其从全局命名空间索引集合中彻底移除。',
    inputs: {
      headers: [
        { name: 'x-gateway-token', type: 'string', required: false, description: '网关鉴权令牌' },
      ],
      params: [
        { name: 'namespace', type: 'string', required: true, description: '待清空的命名空间名称', example: 'temp_ns' },
      ],
      query: [],
      body: [],
    },
    outputs: {
      statusCode: 200,
      description: '命名空间清空完成',
      fields: [
        { name: 'success', type: 'boolean', description: '操作状态' },
        { name: 'message', type: 'string', description: '清空提示语' },
      ],
      example: {
        success: true,
        message: '命名空间 temp_ns 已清空删除',
      },
    },
    curlExample: 'curl -X DELETE http://localhost:3003/api/config/temp_ns',
  },

  // --------------------------------------------------------------------------
  // 3. 健康探针 API
  // --------------------------------------------------------------------------
  {
    key: 'health-check',
    name: '存活与健康状态探针',
    category: '健康探针',
    method: 'GET',
    path: '/health',
    authRequired: false,
    description: '检测网关自身存活状态、Redis 连通性、运行时间 (uptime) 及活跃微服务组件数量。',
    inputs: {
      headers: [],
      params: [],
      query: [],
      body: [],
    },
    outputs: {
      statusCode: 200,
      description: '网关健康状态与组件统计',
      fields: [
        { name: 'status', type: 'string', description: '总体状态: ok 或 degraded' },
        { name: 'service', type: 'string', description: '服务名: a3-internal-gateway' },
        { name: 'uptimeSeconds', type: 'number', description: '运行时长 (秒)' },
        { name: 'components.redis', type: 'string', description: 'Redis 连通性状态: UP 或 DOWN' },
        { name: 'components.activeServicesCount', type: 'number', description: '当前活跃服务实例数' },
        { name: 'timestamp', type: 'string', description: 'ISO 时间戳' },
      ],
      example: {
        status: 'ok',
        service: 'a3-internal-gateway',
        uptimeSeconds: 120,
        components: {
          redis: 'UP',
          activeServicesCount: 2,
        },
        timestamp: '2026-10-19T05:50:00.000Z',
      },
    },
    curlExample: 'curl http://localhost:3003/health',
  },

  // --------------------------------------------------------------------------
  // 4. 网关手册自省中心 API
  // --------------------------------------------------------------------------
  {
    key: 'manual-catalog',
    name: '网关接口手册目录与用法查询',
    category: '网关手册中心',
    method: 'GET',
    path: '/api',
    authRequired: false,
    description: '在网关启动时自动收集所有对外接口。无参数时返回所有接口目录清单；通过 ?index= 参数（支持数字编号、名称/Key、路径）返回特定接口的详细出入参用法与示例。也可通过 /api/manual 访问。',
    inputs: {
      headers: [],
      params: [],
      query: [
        { name: 'index', type: 'string | number', required: false, description: '查询索引参数，支持数字编号 (如 1)、标识 Key (如 register)、或完整路径 (如 /api/registry/register)', example: '1' },
      ],
      body: [],
    },
    outputs: {
      statusCode: 200,
      description: '接口目录或单个接口的出入参详尽规范',
      fields: [
        { name: 'success', type: 'boolean', description: '请求状态' },
        { name: 'data', type: 'object', description: '目录清单对象或单接口详情对象' },
      ],
      example: {
        success: true,
        data: {
          title: 'a3 专属内部微服务网关 (Sidecar Gateway) 接口手册',
          total: 15,
        },
      },
    },
    curlExample: 'curl http://localhost:3003/api',
  },
  {
    key: 'manual-by-index',
    name: '按路径参数获取单接口用法',
    category: '网关手册中心',
    method: 'GET',
    path: '/api/manual/:index',
    authRequired: false,
    description: '通过 RESTful 路径参数直接指定索引序号或接口 Key 获取目标接口用法。例如 /api/manual/1 或 /api/manual/register。',
    inputs: {
      headers: [],
      params: [
        { name: 'index', type: 'string | number', required: true, description: '路径索引参数，支持序号 (如 1) 或 Key (如 register)', example: '1' },
      ],
      query: [],
      body: [],
    },
    outputs: {
      statusCode: 200,
      description: '目标接口的出入参详尽规范',
      fields: [
        { name: 'success', type: 'boolean', description: '请求状态' },
        { name: 'data', type: 'ApiManualItem', description: '单接口完整规范' },
      ],
      example: {
        success: true,
        data: {
          index: 1,
          name: '注册服务实例',
          method: 'POST',
          path: '/api/registry/register',
        },
      },
    },
    curlExample: 'curl http://localhost:3003/api/manual/1',
  },
];
