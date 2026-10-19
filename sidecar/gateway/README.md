# a3 专属内部微服务网关 (服务注册发现与配置中心)

该微服务作为 `ai-agent-application` (a3) 的专属伴生网关（Sidecar），专用于 a3 系统内部各微服务与组件之间的**服务注册与发现**、**健康检测与实例租期管理**、以及**分布式动态配置中心**。

---

## 核心职责

1. **服务注册与发现 (Service Registry & Discovery)**：
   - a3 主服务、`wecom-finance` 等内部组件自动或手动向网关注册服务实例（主机、端口、元数据、租期）；
   - 心跳续约与超时剔除（默认 30s 自动过期）；
   - 动态查询某服务的可用健康实例列表（用于负载均衡与内部反向代理）。
2. **动态配置中心 (Configuration Center)**：
   - 集中存储命名空间配置（如平台参数、企微配置、模型路由策略等）；
   - 写入与修改配置后，自动通过 Redis Channel `ag:cfg:changed` 广播变更通知，实现秒级配置热加载。
3. **备份留存基础能力**：
   - 内置保留企微四层群成员身份识别逻辑（`MemberIdentityService`），供内部各服务与调度模块复用。

---

## API 接口清单

> 📖 **完整与详细的 API 协议规范、入参示例及错误码说明请参阅独立文档：[doc/API.md](file:///home/hyong/code/ai-agent/ai-agent-application/sidecar/gateway/doc/API.md)**。
> 💡 网关服务启动时自动扫描收集所有对外接口，支持通过 `curl http://localhost:3003/api` 随时获取活体手册与出入参说明。

### 0. 接口手册与自省索引中心 (免鉴权)

| 方法 | 路径 | 说明 | 请求体 / 参数示例 |
|---|---|---|---|
| `GET` | `/api` 或 `/api/manual` | 查询接口目录清单或单接口出入参用法 | 可选 `?index=1` 或 `?index=register` |
| `GET` | `/api/manual/:index` | 按路径参数直接查询单接口出入参用法 | 路径参数 `:index` (序号或 Key) |

### 1. 服务注册与发现

| 方法 | 路径 | 说明 | 请求体 / 参数示例 |
|---|---|---|---|
| `POST` | `/api/registry/register` | 注册服务实例 | `{"instanceId":"a3-1","serviceName":"a3-app","host":"127.0.0.1","port":3002}` |
| `POST` | `/api/registry/heartbeat` | 心跳续约保活 | `{"instanceId":"a3-1"}` |
| `POST` | `/api/registry/deregister` | 主动下线注销 | `{"instanceId":"a3-1","serviceName":"a3-app"}` |
| `GET` | `/api/registry/services` | 查询所有存活服务名称 | 无 |
| `GET` | `/api/registry/instances/:serviceName` | 查询指定服务的实例列表 | `serviceName=a3-app` |
| `GET` | `/api/registry/instance/:instanceId` | 查询指定实例详情 | `instanceId=a3-1` |

### 2. 动态配置中心

| 方法 | 路径 | 说明 | 请求体 / 参数示例 |
|---|---|---|---|
| `GET` | `/api/config/namespaces` | 查询所有配置命名空间 | 无 |
| `GET` | `/api/config/:namespace` | 获取命名空间配置字典 (支持 `?detail=true` 查看版本/更新时间/备注) | `namespace=wecom-finance` |
| `GET` | `/api/config/:namespace/:key` | 获取单个配置项详情 | `namespace=wecom-finance&key=pollIntervalMs` |
| `POST` | `/api/config/:namespace` | 设置/更新单个配置并广播变更 | `{"key":"pollIntervalMs","value":1000,"comment":"轮询间隔"}` |
| `POST` | `/api/config/:namespace/batch` | 批量设置/导入配置字典 | `{"configs":{"batchSize":100,"pollIntervalMs":1000},"comment":"批量调整"}` |
| `DELETE`| `/api/config/:namespace/:key` | 删除单个配置项 | 无 |
| `DELETE`| `/api/config/:namespace` | 清空并删除整个命名空间 | 无 |

### 3. 健康检查

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 存活探针与 Redis/服务状态检查 |

---

## 动态配置中心 (CC) 无 UI cURL 运维指南

本网关支持在**完全无 UI** 前提下，通过标准 HTTP/cURL 完成全生命周期配置运维。若配置了 `GATEWAY_AUTH_TOKEN`，在请求头附加 `-H "x-gateway-token: <TOKEN>"`。

### 1. 批量导入/更新配置（如 wecom-finance 运行参数）
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

### 2. 查看命名空间全量配置 (扁平键值 vs 包含元数据详情)
```bash
# 1) 获取扁平字典（供应用直接加载）
curl http://localhost:3003/api/config/wecom-finance

# 2) 查看包含版本号 (version)、更新时间 (updatedAt)、修改备注 (comment) 的详细元数据
curl "http://localhost:3003/api/config/wecom-finance?detail=true"
```

### 3. 修改单项配置 (如动态调整批次大小)
```bash
curl -X POST http://localhost:3003/api/config/wecom-finance \
  -H "Content-Type: application/json" \
  -H "x-gateway-token: ${GATEWAY_AUTH_TOKEN:-}" \
  -d '{"key":"batchSize","value":200,"comment":"业务高峰期调大批次"}'
```

### 4. 查询与删除配置
```bash
# 查询单项
curl http://localhost:3003/api/config/wecom-finance/batchSize

# 删除单项配置
curl -X DELETE http://localhost:3003/api/config/wecom-finance/batchSize

# 清空并删除整个命名空间
curl -X DELETE http://localhost:3003/api/config/wecom-finance
```

---

## 运维与部署

```bash
# 本地开发运行
npm run dev

# 执行单元测试
npm test

# 静态类型检查
npm run typecheck

# 容器化部署 (deploy.sh)
./deploy.sh deploy local    # 本地容器运行
./deploy.sh deploy test     # 测试环境部署
./deploy.sh deploy prod     # 生产环境部署
./deploy.sh status local    # 查看状态
./deploy.sh logs local      # 查看日志
./deploy.sh stop local      # 停止容器
```
