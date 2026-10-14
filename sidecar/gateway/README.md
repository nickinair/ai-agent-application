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
| `GET` | `/api/config/:namespace` | 获取命名空间全量配置 | `namespace=default` |
| `GET` | `/api/config/:namespace/:key` | 获取单个配置项详情 | `namespace=default&key=timeout` |
| `POST` | `/api/config/:namespace` | 设置/更新单个配置并广播变更 | `{"key":"timeout","value":5000}` |
| `POST` | `/api/config/:namespace/batch` | 批量设置配置 | `{"configs":{"k1":"v1","k2":123}}` |
| `DELETE`| `/api/config/:namespace/:key` | 删除配置项 | 无 |

### 3. 健康检查

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 存活探针与 Redis/服务状态检查 |

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
