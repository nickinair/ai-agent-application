# ai-agent-application — 智能体全能平台 · 应用后端

职责：管理 API、规则包 / 参数 / 知识库导入脚本、数据库迁移（技术方案 §4、§13.2、§14）。V1.0 没有前端页面。

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

## 开发

```bash
npm install
npm run build
npm test
npm run typecheck
```

整套环境用 `crm-ai-agent/deploy` 下的 Docker Compose 启动（会先自动执行迁移），见该仓库 README。

## 规划

| 内容 | 任务 |
|---|---|
| 规则包 / 参数模板与导入脚本、热更新 | H4 |
| 知识库导入脚本 | N7 |
| 管理 API：会话查询、转人工记录、成员角色修正（`/api/admin`，JWT） | P1-2 |

## GitLab 流水线与部署

最终部署走 GitLab（`.gitlab-ci.yml`）：任意分支跑测试；合并到 `main` 构建镜像并自动部署测试环境；打 `v*` 标签后手动部署生产。部署失败会自动回滚到上一个版本。迁移步骤、需要配置的变量和服务器准备见 `crm-ai-agent` 仓库的 `docs/GitLab迁移与部署.md`。`.github/workflows/` 只在 GitHub 过渡期使用。
