# ai-agent-application — 智能体全能平台 · 应用后端

职责：管理 API、规则包 / 参数 / 知识库导入脚本、数据库迁移、企微机器人长连接接入及会话内容存档事件接收（技术方案 §4、§13.2、§14）。V1.0 没有前端页面。

---

## 数据库迁移

迁移文件在 `database/migrations/`，按 `V版本-序号-描述.sql` 命名，按序执行：

| 文件 | 内容 |
|---|---|
| `V1.0.0-001-init.sql` | 方案 §12 的全部表结构（38 张，含 §12.6 预留的任务流表） |
| `V1.0.0-002-default-params.sql` | 平台默认参数（附录 A，`tenant_id = 0`） |

```bash
MYSQL_URL=mysql://agent:agent@localhost:3306/agent_platform npm run build && npm run migrate
```

规则：已执行过的文件不能改（脚本会校验 checksum 并拒绝执行），改表结构请新增文件。

---

## 本地开发调试

```bash
# 1. 安装依赖
npm install

# 2. 编译 TypeScript
npm run build

# 3. 运行单元测试与类型检查
npm test
npm run typecheck

# 4. 本地启动服务（默认监听端口 3002）
npm start
```

---

## 部署与运维指南

### 1. 运行依赖与环境要求
- **运行时环境**：Node.js >= 22，Docker >= 24.0，Docker Compose v2；
- **基础中间件**：
  - MySQL 8.0（数据库）
  - Redis 7.0（缓存与事件状态）
  - RabbitMQ 3.13（消息队列）
  - Qdrant 1.12（向量知识库）
- **核心环境变量配置**（可在 `.env` 中定义）：
  | 环境变量 | 默认值 / 示例 | 说明 |
  |---|---|---|
  | `PORT` | `3002` | 应用服务监听端口 |
  | `MYSQL_URL` | `mysql://agent:agent@localhost:3306/agent_platform` | 生产/测试 MySQL 数据库连接串 |
  | `WECOM_BOT_ID` | 可选 | 企微智能机器人 ID（用于 WebSocket 官方长连接） |
  | `WECOM_BOT_SECRET` | 可选 | 企微智能机器人 Secret |
  | `WECOM_BOT_WS_URL` | `wss://openws.work.weixin.qq.com` | 企微机器人长连接网关地址 |
  | `WECOM_BOT_ENABLED` | `false` | 是否开启企微机器人长连接监听 |
  | `WECOM_SIDECAR_TOKEN`| 可选 | 会话内容存档 Sidecar 内部通信安全校验令牌 |

---

### 2. 部署方式一：Docker Compose 联合编排（本地/测试环境推荐）

在 `crm-ai-agent/deploy` 目录下已集成本应用与所有中间件、网关的编排配置：

```bash
# 1. 进入部署目录
cd ../crm-ai-agent/deploy

# 2. 准备环境变量配置
cp .env.example .env

# 3. 一键拉起整套平台（会自动前置执行 migrate 容器完成表结构迁移）
docker compose up -d --build
```

---

### 3. 部署方式二：主应用独立 Docker 容器化部署

若需单独构建并部署应用后端容器：

```bash
# 1. 构建应用 Docker 镜像
docker build -t ai-agent-application:latest .

# 2. 执行数据库迁移（一次性运行后自动退出）
docker run --rm \
  --env MYSQL_URL="mysql://agent:agent@mysql-host:3306/agent_platform" \
  ai-agent-application:latest \
  node dist/database/migrate.js

# 3. 启动应用后端主容器
docker run -d \
  --name ai-agent-application \
  --restart unless-stopped \
  -p 3002:3002 \
  --env-file .env \
  ai-agent-application:latest
```

---

### 4. 部署方式三：伴生服务 wecom-finance Sidecar 独立部署

为了实现外部客户群全量消息（未 @ 机器人）的无感感知，本仓库包含独立的会话内容存档 Sidecar 微服务（位于 [sidecar/wecom-finance](file:///home/hyong/code/ai-agent/ai-agent-application/sidecar/wecom-finance)）。

该 Sidecar 拥有专属的 `deploy.sh` 部署脚本，支持 `local`、`test`、`prod` 三种隔离环境：

```bash
cd sidecar/wecom-finance

# 本地联调部署（自动注入 host.docker.internal 连通宿主机 a3）:
./deploy.sh deploy local    # 或 npm run deploy:local

# 测试环境部署（Mock 模式，开箱即用）:
./deploy.sh deploy test     # 或 npm run deploy:test

# 生产环境部署（Native 原生 C 动态库与真实私钥）:
cp .env.prod.example .env.prod
./deploy.sh deploy prod     # 或 npm run deploy:prod

# 状态查询与日志追踪:
./deploy.sh status [local|test|prod]
./deploy.sh logs [local|test|prod]
```

详细配置与 C 库挂载指引请参阅 [sidecar/wecom-finance/README.md](file:///home/hyong/code/ai-agent/ai-agent-application/sidecar/wecom-finance/README.md)。

---

### 5. 生产流水线与版本回滚（GitLab CI/CD）

- **分支流水线策略**：
  - 任意分支提交：自动运行类型检查与 Jest 测试套件；
  - 合并到 `main` 分支：自动构建生产镜像并自动发布到测试环境；
  - 打 `v*.*.*` 标签（Tag）：手动触发发布生产环境。
- **自动回滚机制**：
  - 生产发布调用 `crm-ai-agent/deploy/scripts/deploy.sh agent-app <tag>` 执行；
  - 启动后自动进行健康探测；若健康检查未通过或服务启动失败，脚本将**自动回滚至上一稳定版本**，保障生产服务高可用。
  - 完整迁移与部署说明见 `crm-ai-agent` 仓库的 `docs/GitLab迁移与部署.md`。

---

## 规划

| 内容 | 任务 |
|---|---|
| 规则包 / 参数模板与导入脚本、热更新 | H4 |
| 知识库导入脚本 | N7 |
| 管理 API：会话查询、转人工记录、成员角色修正（`/api/admin`，JWT） | P1-2 |
