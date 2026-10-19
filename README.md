# ai-agent-application (a3) — 智能体全能平台 · 应用后端

`ai-agent-application`（简称 **a3**）是企业级智能体系统的核心接入与会话治理应用后端。它作为人机交互的第一道门户，负责企微多通道消息全量感知接入、四层成员身份鉴定、高并发消息防抖聚合封组、会话抢话筒仲裁，以及与下游调度平台和伴生微服务（Sidecars）的高效协同。

> 📖 **完整与详细的分层全景架构图、核心业务时序图及设计规范请参阅独立文档：[系统整体架构设计说明书 (doc/ARCHITECTURE.md)](file:///home/hyong/code/ai-agent/ai-agent-application/doc/ARCHITECTURE.md)**。

---

## 1. 系统架构与拓扑关系

根据最新架构设计，a3 与下游各核心组件的整体拓扑流转关系如下：

$$\text{a3 (接入与治理中枢)} \longrightarrow \text{Nginx} \longrightarrow \text{Agents Router} \longrightarrow \text{Inner Gateway} \overset{\text{mult}}{\longrightarrow} \text{Handler Agents}$$

### 简化版系统架构图

```mermaid
flowchart TB
    subgraph Channels ["外部通信渠道"]
        WeComOfficial["企微官方服务"]
        GroupUsers["外部群客户 / 内部员工"]
    end

    subgraph Sidecars ["a3 专属伴生服务 (Sidecars)"]
        direction LR
        WfSidecar["wecom-finance<br/>(会话存档全量感知)"]
        GwSidecar["gateway<br/>(专属 SRF 发现与 CC 配置中心)"]
    end

    subgraph A3 ["a3 主应用核心引擎 (ai-agent-application)"]
        direction TB
        IngressLayer["双通道接入层<br/>• 官方 WebSocket 长连接<br/>• 会话存档感知回调 (/callback)"]
        RuntimeCore["核心会话治理引擎<br/>• 四层身份判定 (Identity)<br/>• 动态防抖封组缓冲 (Buffer)<br/>• 抢话筒并发仲裁 (Microphone)<br/>• 网关自注册与配置热同步"]
        IngressLayer --> RuntimeCore
    end

    subgraph Downstream ["下游智能体中枢"]
        NginxProxy["Nginx 反向代理"]
        AgentsRouter["Agents Router"]
        InnerGw["Inner Gateway"]
        AgentCluster["Handler Agents 多智能体集群<br/>(业务问答 / 工单 / 知识库 / LLM)"]

        NginxProxy --> AgentsRouter --> InnerGw --> AgentCluster
    end

    GroupUsers -->|"发送消息 / @机器人"| WeComOfficial
    WeComOfficial <-->|"WebSocket 长连接"| IngressLayer
    WeComOfficial -->|"拉取加密存档"| WfSidecar

    WfSidecar -->|"1. 寻址 a3 实例"| GwSidecar
    WfSidecar -->|"2. 反向感知推送"| IngressLayer
    A3 <-->|"自注册 / 心跳保活 / 配置同步"| GwSidecar

    RuntimeCore -->|"3. 聚合并发请求 (HTTP POST)"| NginxProxy
    AgentCluster -.->|"打字机流式回复"| IngressLayer
```

---

## 2. 核心功能与技术实现

1. **企业微信双通道全量消息感知**：
   - **通道一（主动 @）**：内置官方智能机器人 WebSocket 双向长连接，实时收发官方 `@Mention` 消息并支持流式打字效果；
   - **通道二（全量无感感知）**：协同 [sidecar/wecom-finance](file:///home/hyong/code/ai-agent/ai-agent-application/sidecar/wecom-finance) 模块，7x24 小时拉取合规加密存档，彻底攻克外部客户群未 `@机器人` 无法感知的难题。
2. **四层成员身份实时识别与裁决 (`MemberIdentityService`)**：
   - 精确区分发言者：`CUSTOMER`（普通客户）、`STAFF`（内部员工）、`SPECIALIST`（专属客服专家）、`BOT`（机器人自身）；
   - 支持人工客服主动介入检测，自动触发机器人避让与话筒出让。
3. **动态防抖封组缓冲池 (`MessageBufferManager`)**：
   - 具备动态防抖定时器（Debounce Timer），客户快速连续发送多条短句时自动合并为完整意图；
   - 具备最大消息条数限制与超时强制截断保护，杜绝无休止等待。
4. **抢话筒并发状态仲裁机制 (`MicrophoneStateArbitrator`)**：
   - 解决同一群聊内多人并发发言与多机器人冲突；
   - 基于分布式锁与租期机制（默认 60s），支持超时自动熔断释放与有序排队。
5. **专属网关伴生集成 (SRF & CC)**：
   - a3 启动自动向专属伴生网关（[sidecar/gateway](file:///home/hyong/code/ai-agent/ai-agent-application/sidecar/gateway)）注册并维持 15s 心跳；
   - 启动自动拉取命名空间配置，并监听 Redis Channel `ag:cfg:changed`，支持秒级免重启热更新。
6. **完备的白盒测试与运维控制 API**：
   - 提供 `/api/test/inject` 测试注入接口，支持在无真实企微账号环境下模拟完整消息流入、身份测试与流程验证。

---

## 3. 项目代码目录全景

```text
ai-agent-application/
├── doc/
│   └── ARCHITECTURE.md         # 系统整体架构设计说明书（完整全景图、时序图、详细说明）
├── database/
│   └── migrations/             # MySQL 数据库迁移脚本（38 张系统核心表）
├── sidecar/
│   ├── gateway/                # a3 专属服务注册发现与配置中心 (Sidecar 1)
│   │   ├── README.md           # 网关使用指南
│   │   └── doc/API.md          # 网关独立 HTTP REST API 说明书
│   └── wecom-finance/          # 会话内容存档全量感知伴生服务 (Sidecar 2)
│       ├── README.md           # 会话存档服务使用指南
│       └── doc/API.md          # 会话存档独立 API 说明书
├── src/
│   ├── index.ts                # 主应用启动入口
│   ├── app.ts                  # Express 运行时装配
│   ├── gateway/                # 专属网关客户端 (注册、心跳保活、配置同步)
│   ├── modules/
│   │   ├── wecom/              # 企微长连接、会话感知回调与打字机流式中继
│   │   ├── buffer/             # 消息防抖聚合与动态封组缓冲池
│   │   ├── arbitrator/         # 抢话筒并发状态仲裁器
│   │   └── identity/           # 四层成员身份判定
│   └── test-inject/            # 模拟注入与白盒测试控制器
├── Dockerfile                  # 主应用容器化镜像
└── package.json                # 项目依赖与运行脚本
```

---

## 4. 环境变量配置清单

可在项目根目录 `.env` 文件中配置以下参数：

| 环境变量 | 默认值 / 示例 | 说明 |
|---|---|---|
| **基础服务配置** | | |
| `PORT` | `3002` | 应用服务监听端口 |
| `NODE_ENV` | `development` | 运行环境（`development` / `test` / `production`） |
| `MYSQL_URL` | `mysql://agent:agent@localhost:3306/agent_platform` | MySQL 数据库连接串 |
| `REDIS_URL` | `redis://localhost:6379` | Redis 缓存与事件总线连接串 |
| **企业微信官方机器人** | | |
| `WECOM_BOT_ENABLED` | `false` | 是否开启企微官方机器人 WebSocket 监听 |
| `WECOM_BOT_ID` | 可选 | 企微机器人 ID |
| `WECOM_BOT_SECRET` | 可选 | 企微机器人 Secret |
| `WECOM_BOT_WS_URL` | `wss://openws.work.weixin.qq.com` | 企微长连接网关地址 |
| **专属网关 (Sidecar/Gateway) 协同** | | |
| `GATEWAY_ENABLED` | `true` | 是否启用 a3 专属伴生网关协同客户端 |
| `GATEWAY_URL` | `http://localhost:3003` | 专属网关服务 HTTP 访问根地址 |
| `GATEWAY_AUTH_TOKEN` | 可选 | 网关通信鉴权安全令牌（需与网关侧保持一致） |
| `GATEWAY_HEARTBEAT_INTERVAL_MS` | `15000` | 向网关上报心跳的间隔（毫秒，默认 15s） |
| **会话存档 (Sidecar/WeCom-Finance) 协同** | | |
| `WECOM_SIDECAR_TOKEN` | 可选 | 会话存档回调通信内部安全校验令牌 |

---

## 5. 容器化一体化部署器 (Deploy Runner) — 交互式与远程部署指南 (推荐)

项目提供了开箱即用的**一体化交互式部署器 [./deploy.sh](file:///home/hyong/code/ai-agent/ai-agent-application/deploy.sh)**，同时支持**终端图形化交互菜单 (TUI)** 与 **CI/CD 静默批处理命令行 (CLI)** 两种模式。

> 💡 **提示**：在根目录下直接执行 `./deploy.sh` 即可启动，请避免使用 `pnpm deploy`（`pnpm deploy` 为 pnpm 内置保留命令，会被包管理器拦截）。

---

### 5.1 交互式终端图形化运行模式 (直接执行 `./deploy.sh`)

无参数直接运行 `./deploy.sh` 时，将自动进入两层级联交互菜单：

```text
  ╭────────────────────────────────────────────────────────────────────────╮
  │        🤖 A3 智能体全能平台 · 容器化部署器 (Deploy Runner)             │
  │           Unified Docker Multi-Service Deployment for A3               │
  ╰────────────────────────────────────────────────────────────────────────╯
```

#### 流程流转体系：
```mermaid
flowchart TD
    L1["【第一级：目标服务器 (单选)】<br/>1. 🏠 本地宿主机 (Localhost)<br/>2. 🧪 测试服务器 (Test Server)<br/>3. 🏢 生产服务器 (Production - 1.1.1.1)<br/>4. 🌐 自定义远程主机 (Custom SSH)"]
    
    L1 -->|"选定工作上下文"| L2["【第二级：对该服务器执行的操作 (单选)】<br/>1. 🚀 部署应用组件 (Deploy) ──► 展开组件多选<br/>2. 📊 状态看板与探针 (Status) ──► 立即探测该服务器并回传结果<br/>3. 📜 查看容器实时日志 (Logs)   ──► 提示选择查看哪个容器日志<br/>4. 🔄 重启服务集群   (Restart) ──► 重启该服务器容器<br/>5. 🛑 优雅停止服务   (Stop)    ──► 逆序停止该服务器容器<br/>6. 🧹 清理容器与网络 (Clean)   ──► 清理该服务器容器与桥接网络<br/>7. ↩️ 返回重新选择   (Back)    ──► 重新选择服务器"]
    
    L2 -->|"选择 Deploy"| L3["【第三级：部署的应用组件 (多选)】<br/>❯ ◉ 1. 🚪 专属微服务网关 (Gateway:3003)<br/>  ◉ 2. 🤖 A3 主应用核心后端 (A3 App:3002)<br/>  ◉ 3. 💬 企微会话存档服务 (Finance Worker)"]
    
    L3 --> Exec["自动按依赖拓扑有序构建启动所选组件并输出实时探针"]
```

#### 快捷按键操作规范：
- `↑` / `↓`（或 `k` / `j`）：上下移动光标指示符 `❯`
- `空格键`：
  - 单选菜单：直接确认当前选中项；
  - 多选菜单：快速切换选中状态（`◉` 绿色高亮选中，`◯` 暗灰未选中）；
- `数字键 1/2/3...`：快速切换或勾选对应编号项；
- `a`：全选（仅多选菜单有效）；
- `i`：反选（仅多选菜单有效）；
- `回车键`：确认当前步骤，进入下一级或启动执行；
- `q` / `Ctrl+C`：安全退出并自动恢复终端光标。

---

### 5.2 命令行批处理模式 (CLI / 适配 CI/CD 自动化)

当在命令行中传入具体参数时，脚本将自动跳过交互菜单，直接以静默非阻塞模式执行：

#### 1. 本地宿主机命令速查：
```bash
# 本地一键全量部署 (自动对接宿主机 host.docker.internal 上的 MySQL/Redis)
./scripts/deploy.sh deploy local

# 仅更新并重新部署本地 A3 主应用
./scripts/deploy.sh deploy local a3

# 查看本地容器运行状态与 HTTP 健康探针
./scripts/deploy.sh status local

# 实时流式追踪本地容器日志
./scripts/deploy.sh logs local a3

# 优雅停止或清理本地专属网络
./scripts/deploy.sh stop local
./scripts/deploy.sh clean local
```

#### 2. 远程宿主机一键部署与运维命令 (如 1.1.1.1)：
通过 `rsync` 增量秒级同步源码，在远端自动完成容器化数据库迁移、依赖拓扑构建与探针检测：
```bash
# 一键同步并部署全套微服务到远程生产服务器 (1.1.1.1)
./scripts/deploy.sh remote 1.1.1.1 prod

# 仅更新远程生产机上的 A3 主应用
./scripts/deploy.sh remote 1.1.1.1 prod a3

# 在本地直接查看远程 1.1.1.1 上的容器运行与健康探针
./scripts/deploy.sh remote-status 1.1.1.1 prod

# 在本地实时流式追踪远程 1.1.1.1 上的 A3 日志 (Ctrl+C 退出)
./scripts/deploy.sh remote-logs 1.1.1.1 prod a3

# 远程停止 1.1.1.1 上的容器
./scripts/deploy.sh remote-stop 1.1.1.1 prod
```

#### 远程连接控制环境变量：
| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `REMOTE_USER` | `root` | 远程宿主机 SSH 登录用户名 |
| `REMOTE_PORT` | `22` | 远程宿主机 SSH 端口 |
| `REMOTE_DIR` | `/opt/ai-agent-application` | 远程宿主机目标部署目录 |
| `SSH_KEY` | 可选 | 自定义 SSH 私钥路径（默认使用 `~/.ssh/id_rsa`） |
| `SKIP_SYNC` | `false` | 设为 `true` 时跳过代码传输，仅触发远端重构部署 |
| `SKIP_MIGRATE` | `false` | 设为 `true` 时跳过数据库表结构自动迁移 |



---

## 6. 各组件独立运行与详细文档索引

除整合脚本外，各子模块亦支持完全独立构建与本地单测运行：

### 6.1 专属服务网关 ([sidecar/gateway](file:///home/hyong/code/ai-agent/ai-agent-application/sidecar/gateway))
负责服务注册发现 (SRF) 与配置中心 (CC)：
- 源码目录：`sidecar/gateway`
- 本地启动：`cd sidecar/gateway && npm run build && npm start`（监听 3003）
- 独立 API 规范与 cURL 运维指南：[sidecar/gateway/doc/API.md](file:///home/hyong/code/ai-agent/ai-agent-application/sidecar/gateway/doc/API.md)

### 6.2 会话内容存档服务 ([sidecar/wecom-finance](file:///home/hyong/code/ai-agent/ai-agent-application/sidecar/wecom-finance))
负责外部客户群 7x24 小时全量消息感知与解密反向推送：
- 源码目录：`sidecar/wecom-finance`
- 独立部署脚本：`cd sidecar/wecom-finance && ./deploy.sh deploy local`
- 独立 API 规范与数据字典：[sidecar/wecom-finance/doc/API.md](file:///home/hyong/code/ai-agent/ai-agent-application/sidecar/wecom-finance/doc/API.md)

---

## 7. 本地源码开发与数据库迁移

```bash
# 1. 安装主应用依赖
npm install

# 2. 编译 TypeScript 代码
npm run build

# 3. 执行数据库迁移（38 张系统表与初始参数）
MYSQL_URL=mysql://agent:agent@localhost:3306/agent_platform npm run migrate

# 4. 运行单元测试套件与类型检查
npm test
npm run typecheck

# 5. 启动应用主服务（默认端口 3002）
npm start
```

---

## 8. 生产部署与 CI/CD 策略

- **分支流水线**：
  - 任意分支提交：自动执行 `npm run typecheck` 与 Jest 自动化测试套件；
  - 合并至 `main` 分支：自动打包容器镜像并部署到测试环境；
  - 发布 Tag（如 `v1.0.0`）：触发生产环境部署。
- **高可用与自动回滚**：
  - 生产发布脚本启动后自动执行心跳探活与健康检查；若启动异常或探活失败，自动执行镜像版本回滚，保障线上服务不中断。
