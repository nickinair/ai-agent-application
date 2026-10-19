# a3 专属内部微服务网关 (Sidecar Gateway) API 说明文档

该文档为 `ai-agent-application` (a3) 伴生网关微服务的官方接口规范。网关默认运行于端口 **`3003`**，核心提供**服务注册与发现中心 (SRF)** 与 **动态配置中心 (CC)** 两大基础设施能力。

---

## 目录
- [零、 网关接口手册与自省索引 API (Manual & Introspection)](#零-网关接口手册与自省索引-api-manual--introspection)
  - [1. 接口手册目录与用法查询 (`GET /api` 或 `GET /api/manual`)](#1-接口手册目录与用法查询-get-api-或-get-apimanual)
  - [2. 按路径参数获取单接口用法 (`GET /api/manual/:index`)](#2-按路径参数获取单接口用法-get-apimanualindex)
- [一、 全局接口与通信规范](#一-全局接口与通信规范)
  - [1. 基础信息](#1-基础信息)
  - [2. 安全鉴权机制 (Auth)](#2-安全鉴权机制-auth)
  - [3. 统一响应体结构](#3-统一响应体结构)
  - [4. HTTP 状态码规范](#4-http-状态码规范)
- [二、 服务注册与发现中心 (SRF) API](#二-服务注册与发现中心-srf-api)
  - [1. 注册服务实例 (`POST /api/registry/register`)](#1-注册服务实例-post-apiregistryregister)
  - [2. 心跳续约保活 (`POST /api/registry/heartbeat`)](#2-心跳续约保活-post-apiregistryheartbeat)
  - [3. 主动下线注销 (`POST /api/registry/deregister`)](#3-主动下线注销-post-apiregistryderegister)
  - [4. 查询所有存活服务名 (`GET /api/registry/services`)](#4-查询所有存活服务名-get-apiregistryservices)
  - [5. 查询指定服务健康实例 (`GET /api/registry/instances/:serviceName`)](#5-查询指定服务健康实例-get-apiregistryinstancesservicename)
  - [6. 查询单实例详情 (`GET /api/registry/instance/:instanceId`)](#6-查询单实例详情-get-apiregistryinstanceinstanceid)
- [三、 动态配置中心 (CC) API](#三-动态配置中心-cc-api)
  - [1. 列出所有命名空间 (`GET /api/config/namespaces`)](#1-列出所有命名空间-get-apiconfignamespaces)
  - [2. 查询命名空间配置 (`GET /api/config/:namespace`)](#2-查询命名空间配置-get-apiconfignamespace)
  - [3. 获取单个配置项 (`GET /api/config/:namespace/:key`)](#3-获取单个配置项-get-apiconfignamespacekey)
  - [4. 设置/更新单项配置 (`POST /api/config/:namespace`)](#4-设置更新单项配置-post-apiconfignamespace)
  - [5. 批量导入/更新配置 (`POST /api/config/:namespace/batch`)](#5-批量导入更新配置-post-apiconfignamespacebatch)
  - [6. 删除单个配置项 (`DELETE /api/config/:namespace/:key`)](#6-删除单个配置项-delete-apiconfignamespacekey)
  - [7. 清空整个命名空间 (`DELETE /api/config/:namespace`)](#7-清空整个命名空间-delete-apiconfignamespace)
- [四、 健康探针 API](#四-健康探针-api)
  - [1. 存活与健康状态 (`GET /health`)](#1-存活与健康状态-get-health)
- [五、 无 UI cURL 运维实操速查](#五-无-ui-curl-运维实操速查)

---

## 零、 网关接口手册与自省索引 API (Manual & Introspection)

网关在微服务启动时（`onApplicationBootstrap` 生命周期）自动自省收集所有已加载的对外 HTTP 接口与路由，并与参数定义表自动整合为活体手册文档。调用方可随时查阅目录或按索引参数获取特定接口的出/入参数完整规范。手册接口完全公开，免鉴权访问。

### 1. 接口手册目录与用法查询 (`GET /api` 或 `GET /api/manual`)
- **接口说明**：
  - **不带参数**：返回所有存活对外接口的目录清单（含接口序号、唯一标识、HTTP 方法、请求路径、分类与描述）；
  - **携带 `?index=` 参数**：返回对应接口的出/入参数说明、响应模型与 cURL 范例。
- **请求方法**：`GET`
- **请求路径**：`/api` 或 `/api/manual`
- **查询参数 (Query)**：
  | 字段名 | 类型 | 必填 | 说明 | 示例 |
  | :--- | :--- | :---: | :--- | :--- |
  | `index` | string \| number | 否 | 索引参数，支持数字编号（如 `1`）、接口标识 Key（如 `register`）、或路由路径（如 `/api/registry/register`） | `"1"` 或 `"register"` |

- **请求示例**：
```bash
# 获取目录总表
curl http://localhost:3003/api

# 按数字序号获取用法 (出入参数)
curl "http://localhost:3003/api?index=1"

# 按接口标识获取用法
curl "http://localhost:3003/api?index=register"

# 按路由路径获取用法
curl "http://localhost:3003/api?index=/api/registry/register"
```

- **目录总表成功响应 (无参数)**：
```json
{
  "success": true,
  "data": {
    "title": "a3 专属内部微服务网关 (Sidecar Gateway) 接口手册",
    "version": "1.0.0",
    "total": 16,
    "usageTip": "通过索引参数获取详细用法，例如: curl http://localhost:3003/api?index=1 或 curl http://localhost:3003/api/manual?index=register",
    "catalog": [
      {
        "index": 1,
        "key": "registry-deregister",
        "method": "POST",
        "path": "/api/registry/deregister",
        "category": "服务注册与发现中心 (SRF)",
        "summary": "主动注销服务实例",
        "authRequired": true,
        "detailUrl": "/api/manual?index=1"
      },
      {
        "index": 2,
        "key": "registry-heartbeat",
        "method": "POST",
        "path": "/api/registry/heartbeat",
        "category": "服务注册与发现中心 (SRF)",
        "summary": "心跳续约保活",
        "authRequired": true,
        "detailUrl": "/api/manual?index=2"
      }
    ]
  }
}
```

- **单接口用法成功响应 (`?index=5`)**：
```json
{
  "success": true,
  "data": {
    "index": 5,
    "key": "registry-register",
    "name": "注册服务实例",
    "category": "服务注册与发现中心 (SRF)",
    "method": "POST",
    "path": "/api/registry/register",
    "authRequired": true,
    "description": "微服务组件启动时向网关注册实例标识、服务名、IP、端口及元数据，启动 TTL 存活租期。",
    "inputs": {
      "headers": [
        { "name": "Content-Type", "type": "string", "required": true, "default": "application/json", "description": "请求体数据格式" },
        { "name": "x-gateway-token", "type": "string", "required": false, "description": "网关鉴权令牌" }
      ],
      "params": [],
      "query": [],
      "body": [
        { "name": "instanceId", "type": "string", "required": true, "description": "实例唯一标识", "example": "a3-node-1" },
        { "name": "serviceName", "type": "string", "required": true, "description": "服务逻辑名称", "example": "ai-agent-application" },
        { "name": "host", "type": "string", "required": true, "description": "服务所在 IP 或可达主机名", "example": "127.0.0.1" },
        { "name": "port", "type": "number", "required": true, "description": "服务监听端口", "example": 3002 },
        { "name": "metadata", "type": "object", "required": false, "description": "自定义元数据字典" },
        { "name": "ttlSeconds", "type": "number", "required": false, "default": 30, "description": "租期存活秒数" }
      ]
    },
    "outputs": {
      "statusCode": 200,
      "description": "实例注册成功，返回完整的服务实例信息",
      "fields": [
        { "name": "success", "type": "boolean", "description": "操作状态" },
        { "name": "data.instanceId", "type": "string", "description": "实例唯一标识" },
        { "name": "data.status", "type": "string", "description": "服务状态 (UP/DOWN)" }
      ],
      "example": {
        "success": true,
        "data": {
          "instanceId": "a3-node-1",
          "serviceName": "ai-agent-application",
          "status": "UP"
        }
      }
    },
    "curlExample": "curl -X POST http://localhost:3003/api/registry/register -H \"Content-Type: application/json\" -d '{\"instanceId\":\"a3-node-1\",\"serviceName\":\"ai-agent-application\",\"host\":\"127.0.0.1\",\"port\":3002}'"
  }
}
```

---

### 2. 按路径参数获取单接口用法 (`GET /api/manual/:index`)
- **接口说明**：通过 RESTful 路径参数直接指定索引序号或接口 Key 获取目标接口用法。
- **请求方法**：`GET`
- **请求路径**：`/api/manual/:index`
- **路径参数 (Path Params)**：
  | 字段名 | 类型 | 必填 | 说明 | 示例 |
  | :--- | :--- | :---: | :--- | :--- |
  | `index` | string \| number | 是 | 接口序号或唯一标识 Key | `"1"` 或 `"config-namespaces"` |

- **请求示例**：
```bash
curl http://localhost:3003/api/manual/1
curl http://localhost:3003/api/manual/health
```

---

## 一、 全局接口与通信规范

### 1. 基础信息
- **通信协议**：HTTP / RESTful
- **数据传输格式**：`application/json` (UTF-8)
- **默认服务端口**：`3003`（可通过环境变量 `PORT` 配置）
- **持久化后端**：Redis（单机或集群，支持租期 TTL 与 Pub/Sub 广播）

### 2. 安全鉴权机制 (Auth)
若网关启动时配置了 `GATEWAY_AUTH_TOKEN`，所有访问 `/api/registry/*` 和 `/api/config/*` 的请求均需携带合法 Token（未配置时默认放行，本地开发零摩擦）：
- **方式一（推荐 Header）**：`x-gateway-token: <GATEWAY_AUTH_TOKEN>`
- **方式二（Bearer Authorization）**：`Authorization: Bearer <GATEWAY_AUTH_TOKEN>`

### 3. 统一响应体结构
接口统一遵循以下响应体信封规范：
```json
{
  "success": true,
  "data": { ... },
  "message": "可选业务提示信息"
}
```

### 4. HTTP 状态码规范
| 状态码 | 说明 |
| :--- | :--- |
| `200 OK` | 操作成功，结果在 `data` 字段中返回 |
| `400 Bad Request` | 请求参数缺失或校验失败 |
| `401 Unauthorized` | 缺失或提供了错误的鉴权 Token (`GATEWAY_AUTH_TOKEN`) |
| `404 Not Found` | 请求的实例、服务或配置项不存在 |
| `500 Internal Error` | 网关内部或 Redis 连接异常 |

---

## 二、 服务注册与发现中心 (SRF) API

### 1. 注册服务实例 (`POST /api/registry/register`)
- **接口说明**：组件（如 a3 主程序、wecom-finance Sidecar）启动时向网关注册实例信息。
- **请求方法**：`POST`
- **请求路径**：`/api/registry/register`
- **请求体 (JSON)**：
  | 字段名 | 类型 | 必填 | 说明 | 示例 |
  | :--- | :--- | :---: | :--- | :--- |
  | `instanceId` | string | 是 | 实例唯一标识 | `"a3-core-node-1"` |
  | `serviceName` | string | 是 | 服务逻辑名称 | `"ai-agent-application"` |
  | `host` | string | 是 | 服务所在 IP 或可达主机名 | `"127.0.0.1"` |
  | `port` | number | 是 | 服务监听端口 | `3002` |
  | `metadata` | object | 否 | 自定义元数据字典 | `{"version":"1.0.0","webhookPath":"/api/admin/wecom/finance-inbound"}` |
  | `ttlSeconds` | number | 否 | 租期存活秒数（默认 30s） | `30` |

- **请求示例**：
```bash
curl -X POST http://localhost:3003/api/registry/register \
  -H "Content-Type: application/json" \
  -H "x-gateway-token: ${GATEWAY_AUTH_TOKEN:-}" \
  -d '{
    "instanceId": "a3-node-1",
    "serviceName": "ai-agent-application",
    "host": "127.0.0.1",
    "port": 3002,
    "metadata": {
      "version": "1.0.0",
      "type": "app-backend",
      "webhookPath": "/api/admin/wecom/finance-inbound"
    },
    "ttlSeconds": 30
  }'
```
- **成功响应**：
```json
{
  "success": true,
  "data": {
    "instanceId": "a3-node-1",
    "serviceName": "ai-agent-application",
    "host": "127.0.0.1",
    "port": 3002,
    "metadata": {
      "version": "1.0.0",
      "type": "app-backend",
      "webhookPath": "/api/admin/wecom/finance-inbound"
    },
    "registeredAt": 1729300000000,
    "lastHeartbeat": 1729300000000,
    "ttlSeconds": 30,
    "status": "UP"
  }
}
```

---

### 2. 心跳续约保活 (`POST /api/registry/heartbeat`)
- **接口说明**：实例按周期（建议 10s 一次）发送心跳以续借 30s 租期。若实例由于超时已被剔除，接口将返回失败，客户端应感知并触发重新注册。
- **请求方法**：`POST`
- **请求路径**：`/api/registry/heartbeat`
- **请求体 (JSON)**：
  | 字段名 | 类型 | 必填 | 说明 | 示例 |
  | :--- | :--- | :---: | :--- | :--- |
  | `instanceId` | string | 是 | 注册时的实例唯一标识 | `"a3-node-1"` |
  | `serviceName` | string | 否 | 服务名称（可选，辅助校验） | `"ai-agent-application"` |

- **请求示例**：
```bash
curl -X POST http://localhost:3003/api/registry/heartbeat \
  -H "Content-Type: application/json" \
  -H "x-gateway-token: ${GATEWAY_AUTH_TOKEN:-}" \
  -d '{"instanceId":"a3-node-1","serviceName":"ai-agent-application"}'
```
- **成功响应**：
```json
{
  "success": true,
  "data": {
    "instanceId": "a3-node-1",
    "lastHeartbeat": 1729300010000,
    "status": "UP"
  }
}
```

---

### 3. 主动下线注销 (`POST /api/registry/deregister`)
- **接口说明**：组件优雅关机时主动调用，立即从注册表中摘除该实例，无需等待 30s 超时剔除。
- **请求方法**：`POST`
- **请求路径**：`/api/registry/deregister`
- **请求体 (JSON)**：
  | 字段名 | 类型 | 必填 | 说明 | 示例 |
  | :--- | :--- | :---: | :--- | :--- |
  | `instanceId` | string | 是 | 待注销实例标识 | `"a3-node-1"` |
  | `serviceName` | string | 否 | 服务名称 | `"ai-agent-application"` |

- **请求示例**：
```bash
curl -X POST http://localhost:3003/api/registry/deregister \
  -H "Content-Type: application/json" \
  -H "x-gateway-token: ${GATEWAY_AUTH_TOKEN:-}" \
  -d '{"instanceId":"a3-node-1","serviceName":"ai-agent-application"}'
```
- **成功响应**：
```json
{
  "success": true
}
```

---

### 4. 查询所有存活服务名 (`GET /api/registry/services`)
- **接口说明**：获取注册中心当前存活的所有服务类型名称列表。
- **请求方法**：`GET`
- **请求路径**：`/api/registry/services`
- **成功响应**：
```json
{
  "success": true,
  "data": [
    "ai-agent-application",
    "wecom-finance"
  ]
}
```

---

### 5. 查询指定服务健康实例 (`GET /api/registry/instances/:serviceName`)
- **接口说明**：动态获取指定服务当前所有处于存活状态的实例列表（常用于下游调用方动态解析服务地址与负载均衡）。
- **请求方法**：`GET`
- **路径参数**：`serviceName`（例如 `ai-agent-application` 或 `wecom-finance`）
- **请求示例**：
```bash
curl http://localhost:3003/api/registry/instances/ai-agent-application
```
- **成功响应**：
```json
{
  "success": true,
  "data": [
    {
      "instanceId": "a3-node-1",
      "serviceName": "ai-agent-application",
      "host": "127.0.0.1",
      "port": 3002,
      "metadata": {
        "version": "1.0.0",
        "type": "app-backend",
        "webhookPath": "/api/admin/wecom/finance-inbound"
      },
      "status": "UP",
      "lastHeartbeat": 1729300010000,
      "ttlSeconds": 30
    }
  ]
}
```

---

### 6. 查询单实例详情 (`GET /api/registry/instance/:instanceId`)
- **接口说明**：按实例 ID 查询其详细注册元数据与租期信息。若实例不存在或已过期，返回 `404 Not Found`。
- **请求方法**：`GET`
- **路径参数**：`instanceId`

---

## 三、 动态配置中心 (CC) API

### 1. 列出所有命名空间 (`GET /api/config/namespaces`)
- **接口说明**：获取当前配置中心已存储的所有配置命名空间名称列表。
- **请求方法**：`GET`
- **请求路径**：`/api/config/namespaces`
- **成功响应**：
```json
{
  "success": true,
  "data": [
    "default",
    "wecom-finance",
    "tenant_1"
  ]
}
```

---

### 2. 查询命名空间配置 (`GET /api/config/:namespace`)
- **接口说明**：获取指定命名空间下的全部配置项。
- **请求参数**：
  - `namespace` (Path)：命名空间名称（如 `wecom-finance`）
  - `detail` (Query，可选)：`true` 或 `false`。
    - **`detail=false`（默认）**：返回扁平纯净的 `{ key: value }` 字典，供业务组件直接解析；
    - **`detail=true`**：返回携带版本号 (`version`)、更新时间 (`updatedAt`)、修改备注 (`comment`) 的完整元数据字典，方便运维审查。

- **扁平模式请求示例**：
```bash
curl http://localhost:3003/api/config/wecom-finance
```
- **扁平模式响应**：
```json
{
  "success": true,
  "data": {
    "pollIntervalMs": 1000,
    "batchSize": 100,
    "driverMode": "mock"
  }
}
```

- **详情模式请求示例**：
```bash
curl "http://localhost:3003/api/config/wecom-finance?detail=true"
```
- **详情模式响应**：
```json
{
  "success": true,
  "data": {
    "pollIntervalMs": {
      "namespace": "wecom-finance",
      "key": "pollIntervalMs",
      "value": 1000,
      "version": 1,
      "updatedAt": 1729300050000,
      "comment": "长轮询拉取频率"
    },
    "batchSize": {
      "namespace": "wecom-finance",
      "key": "batchSize",
      "value": 100,
      "version": 2,
      "updatedAt": 1729300090000,
      "comment": "单批次最大消息数"
    }
  }
}
```

---

### 3. 获取单个配置项 (`GET /api/config/:namespace/:key`)
- **接口说明**：获取指定命名空间下某一个 Key 的完整配置对象。若不存在返回 `404`。
- **请求示例**：
```bash
curl http://localhost:3003/api/config/wecom-finance/batchSize
```
- **成功响应**：
```json
{
  "success": true,
  "data": {
    "namespace": "wecom-finance",
    "key": "batchSize",
    "value": 100,
    "version": 2,
    "updatedAt": 1729300090000,
    "comment": "单批次最大消息数"
  }
}
```

---

### 4. 设置/更新单项配置 (`POST /api/config/:namespace`)
- **接口说明**：新增或修改指定命名空间下的单条配置项。系统会自动递增版本号，并向 Redis Channel `ag:cfg:changed` 广播变更通知。
- **请求方法**：`POST`
- **请求路径**：`/api/config/:namespace`
- **请求体 (JSON)**：
  | 字段名 | 类型 | 必填 | 说明 | 示例 |
  | :--- | :--- | :---: | :--- | :--- |
  | `key` | string | 是 | 配置键名 | `"batchSize"` |
  | `value` | any | 是 | 配置值（支持 string, number, boolean, object 等） | `200` |
  | `comment` | string | 否 | 修改备注信息 | `"调整高峰期单批拉取量"` |

- **请求示例**：
```bash
curl -X POST http://localhost:3003/api/config/wecom-finance \
  -H "Content-Type: application/json" \
  -H "x-gateway-token: ${GATEWAY_AUTH_TOKEN:-}" \
  -d '{
    "key": "batchSize",
    "value": 200,
    "comment": "调整高峰期单批拉取量"
  }'
```
- **成功响应**：
```json
{
  "success": true,
  "data": {
    "namespace": "wecom-finance",
    "key": "batchSize",
    "value": 200,
    "version": 3,
    "updatedAt": 1729300120000,
    "comment": "调整高峰期单批拉取量"
  }
}
```

---

### 5. 批量导入/更新配置 (`POST /api/config/:namespace/batch`)
- **接口说明**：一次性批量设置或覆盖某命名空间下的多项配置（非常适用于无 UI 环境下的配置文件初始化与自动化导入）。
- **请求方法**：`POST`
- **请求路径**：`/api/config/:namespace/batch`
- **请求体 (JSON)**：
  | 字段名 | 类型 | 必填 | 说明 | 示例 |
  | :--- | :--- | :---: | :--- | :--- |
  | `configs` | object | 是 | 键值对字典 | `{"k1": "v1", "k2": 123}` |
  | `comment` | string | 否 | 批量修改备注 | `"初始化运行参数"` |

- **请求示例**：
```bash
curl -X POST http://localhost:3003/api/config/wecom-finance/batch \
  -H "Content-Type: application/json" \
  -H "x-gateway-token: ${GATEWAY_AUTH_TOKEN:-}" \
  -d '{
    "configs": {
      "pollIntervalMs": 1000,
      "batchSize": 100,
      "driverMode": "mock"
    },
    "comment": "初始化会话存档动态配置"
  }'
```
- **成功响应**：
```json
{
  "success": true,
  "data": {
    "pollIntervalMs": 1000,
    "batchSize": 100,
    "driverMode": "mock"
  }
}
```

---

### 6. 删除单个配置项 (`DELETE /api/config/:namespace/:key`)
- **接口说明**：删除命名空间下的某个键，并向 Redis Channel 广播删除事件。
- **请求方法**：`DELETE`
- **请求路径**：`/api/config/:namespace/:key`
- **请求示例**：
```bash
curl -X DELETE http://localhost:3003/api/config/wecom-finance/batchSize \
  -H "x-gateway-token: ${GATEWAY_AUTH_TOKEN:-}"
```
- **成功响应**：
```json
{
  "success": true
}
```

---

### 7. 清空整个命名空间 (`DELETE /api/config/:namespace`)
- **接口说明**：级联清空并删除整个命名空间的数据及其在 Redis 命名空间集合中的注册。
- **请求方法**：`DELETE`
- **请求路径**：`/api/config/:namespace`
- **请求示例**：
```bash
curl -X DELETE http://localhost:3003/api/config/wecom-finance \
  -H "x-gateway-token: ${GATEWAY_AUTH_TOKEN:-}"
```
- **成功响应**：
```json
{
  "success": true,
  "message": "命名空间 wecom-finance 已清空删除"
}
```

---

## 四、 健康探针 API

### 1. 存活与健康状态 (`GET /health`)
- **接口说明**：K8s / Docker 存活就绪探针以及服务集群状态监控接口，无需鉴权。
- **请求方法**：`GET`
- **请求路径**：`/health`
- **请求示例**：
```bash
curl http://localhost:3003/health
```
- **成功响应**：
```json
{
  "status": "ok",
  "timestamp": "2026-10-19T09:40:00.000Z",
  "uptime": 3600.5,
  "redis": {
    "status": "connected"
  },
  "registry": {
    "totalServices": 2,
    "services": [
      {
        "serviceName": "ai-agent-application",
        "instanceCount": 1
      },
      {
        "serviceName": "wecom-finance",
        "instanceCount": 1
      }
    ]
  }
}
```

---

## 五、 无 UI cURL 运维实操速查

在无 Web 前端界面的部署环境中，运维与开发人员可通过以下命令一键完成典型配置操作：

```bash
GATEWAY_URL="http://localhost:3003"
TOKEN="${GATEWAY_AUTH_TOKEN:-}"

# 1. 检查网关与 Redis 健康状态
curl "${GATEWAY_URL}/health"

# 2. 一键导入 wecom-finance 生产参数
curl -X POST "${GATEWAY_URL}/api/config/wecom-finance/batch" \
  -H "Content-Type: application/json" \
  -H "x-gateway-token: ${TOKEN}" \
  -d '{
    "configs": {
      "pollIntervalMs": 800,
      "batchSize": 200,
      "driverMode": "native"
    },
    "comment": "上线初始化"
  }'

# 3. 运维审计查看配置元数据 (版本号与修改时间)
curl "${GATEWAY_URL}/api/config/wecom-finance?detail=true"

# 4. 动态调整拉取间隔
curl -X POST "${GATEWAY_URL}/api/config/wecom-finance" \
  -H "Content-Type: application/json" \
  -H "x-gateway-token: ${TOKEN}" \
  -d '{"key":"pollIntervalMs","value":500,"comment":"大促提速"}'

# 5. 查看下游存活的 a3 实例及动态 Webhook 地址
curl "${GATEWAY_URL}/api/registry/instances/ai-agent-application"
```
