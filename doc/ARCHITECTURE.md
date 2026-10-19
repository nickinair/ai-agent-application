# ai-agent-application (a3) 系统整体架构设计说明书

本文档详细阐述 `ai-agent-application`（以下简称 **a3**）的系统分层架构、核心运行时机制、伴生微服务（Sidecars）协同原理以及关键业务时序流。

---

## 1. 架构演进与系统定位

根据最新系统架构规划，整体调度拓扑已演化为：

$$\text{a3 (主服务)} \longrightarrow \text{Nginx} \longrightarrow \text{Agents Router} \longrightarrow \text{Inner Gateway} \overset{\text{mult}}{\longrightarrow} \text{Handler Agents}$$

在此架构体系中，**a3 作为最前端的会话接入与多模态感知中枢**，承担企业微信多通道消息监听、客户发言缓冲聚合防抖、抢话筒并发仲裁等关键职责。为了保证 a3 进程的单一职责与高可用性，系统采用了 **Sidecar（边车伴生服务）架构模式**：
- [sidecar/gateway](file:///home/hyong/code/ai-agent/ai-agent-application/sidecar/gateway)：a3 专属服务注册与发现中心 (SRF) 及动态配置中心 (CC)。
- [sidecar/wecom-finance](file:///home/hyong/code/ai-agent/ai-agent-application/sidecar/wecom-finance)：企业微信会话内容存档 (Finance SDK) 独立拉取、解密与反向感知推送服务。

---

## 2. 完整分层全景架构图

```mermaid
flowchart TB
    %% 外部交互与物理通信层
    subgraph Layer_Channels ["外部通信与交互渠道层 (External Channels)"]
        direction LR
        WeComServer["企业微信官方服务群<br/>(企微云端开放平台)"]
        Customer["外部社群客户 / VIP客户<br/>(主动提问 / 发送消息)"]
        InternalStaff["内部企业微信员工 / 专家<br/>(专属客服 / 销售人员)"]
    end

    Customer -->|"发送普通消息 / @机器人"| WeComServer
    InternalStaff -->|"人工客服介入发言 / @机器人"| WeComServer

    %% Sidecar 伴生微服务集群
    subgraph Layer_Sidecars ["a3 专属伴生服务集群 (Sidecar Services)"]
        direction TB

        subgraph SC_Gateway ["sidecar/gateway (专属网关)"]
            direction TB
            GW_SRF["服务注册与发现 (SRF)<br/>• 租期心跳保活 (30s 超时)<br/>• 动态实例健康列表"]
            GW_CC["动态配置中心 (CC)<br/>• 命名空间参数配置<br/>• 变更广播 (Redis Pub/Sub)"]
            GW_MemberID["成员四层身份裁决引擎<br/>• (基础组件复用)"]
        end

        subgraph SC_Finance ["sidecar/wecom-finance (会话存档)"]
            direction TB
            WF_Driver["Finance Driver<br/>(Native C-SDK / Mock 驱动)"]
            WF_Crypto["双阶段安全解密<br/>(RSA PKCS#1 + AES-256)"]
            WF_Seq["Seq 游标状态机<br/>(断点续拉 / 持久化)"]
            WF_Publisher["智能回调调度器<br/>(向 Gateway 动态寻址 A3)"]
        end
    end

    %% a3 核心运行时应用
    subgraph Layer_A3 ["a3 主应用核心引擎 (ai-agent-application)"]
        direction TB

        subgraph A3_Ingress ["多通道接入感知层 (Ingress)"]
            BotWsIngress["官方 WebSocket 智能机器人长连接<br/>(收发双向 / 监听 @Mention)"]
            FinanceCallback["会话存档感知回调端点<br/>(/api/wecom/finance/callback)"]
            TestAdminApi["白盒测试与运维控制 API<br/>(/api/test/inject)"]
        end

        subgraph A3_Core ["核心仲裁与聚合引擎 (Core Runtime)"]
            IdentityResolver["四层身份识别器 (MemberIdentityService)<br/>(普通用户 / 员工 / 客服 / 机器人自身)"]
            BufferManager["动态封组与防抖缓冲池 (MessageBufferManager)<br/>• 动态防抖定时器 (Debounce Timer)<br/>• 最大消息条数与超时强制截断"]
            MicArbitrator["抢话筒与并发状态仲裁器 (MicrophoneStateArbitrator)<br/>• 话筒持有锁 (Redis/内存)<br/>• 租期过期自动熔断与释放"]
            GatewayClientComp["网关自发现客户端 (GatewayRegistryService)<br/>• 启动注册 / 30s 心跳续期<br/>• 订阅 ag:cfg:changed 配置热更新"]
        end

        subgraph A3_Egress ["下游任务派发层 (Egress)"]
            AgentDispatcher["智能体任务调度派发器<br/>(封装规范化 Payload)"]
            BotTypingStreamer["打字机流式输出中继<br/>(WeCom Bot Stream)"]
        end
    end

    %% 存储与缓存层
    subgraph Layer_Storage ["基础设施与存储层 (Storage & Middleware)"]
        RedisPool[("Redis 缓存 & 消息总线<br/>• 话筒互斥锁<br/>• 配置变更通道 (ag:cfg:changed)<br/>• 注册表与实例租期 (ag:reg:*)")]
        SeqStore[("本地游标存储 (Seq File / DB)<br/>断点续拉防丢记录")]
    end

    %% 外部路由与下游智能体集群
    subgraph Layer_Downstream ["下游调度与业务处理 (Downstream Agents)"]
        NginxIngress["Nginx 统一反向代理网关"]
        AgentsRouter["Agents Router (智能路由分发中心)"]
        InnerGateway["Inner Gateway (内网网关集群)"]
        subgraph HandlerAgents ["Handler Agents (专业智能体集群)"]
            AgentA["业务问答 Agent"]
            AgentB["工单处理 Agent"]
            AgentC["知识库检索 Agent"]
            LLMEngine["大模型推理引擎 (LLM Engine)"]
        end
    end

    %% 数据链路拓扑连线
    WeComServer -->|"1. 存档密文拉取"| WF_Driver
    WeComServer <-->|"WebSocket 官方双向连接"| BotWsIngress

    WF_Driver --> WF_Crypto --> WF_Seq --> WF_Publisher
    WF_Seq -.->|"更新游标"| SeqStore

    WF_Publisher -->|"2. 动态发现 a3 实例"| GW_SRF
    WF_Publisher -->|"3. 反向感知回调 (HTTP POST)"| FinanceCallback

    FinanceCallback --> IdentityResolver
    BotWsIngress --> IdentityResolver
    TestAdminApi --> IdentityResolver

    IdentityResolver --> BufferManager
    BufferManager -->|"触发封组封包"| MicArbitrator
    MicArbitrator <-->|"分布式锁与话筒状态"| RedisPool

    A3_Core <-->|"维持心跳 / 获取动态配置"| SC_Gateway
    GW_CC -.->|"发布配置变更广播"| RedisPool
    RedisPool -.->|"订阅热更新事件"| GatewayClientComp

    MicArbitrator -->|"抢占成功，装配上下文"| AgentDispatcher
    AgentDispatcher -->|"HTTP POST (a3 -> Nginx)"| NginxIngress

    NginxIngress --> AgentsRouter
    AgentsRouter --> InnerGateway
    InnerGateway --> HandlerAgents
    HandlerAgents --> LLMEngine

    HandlerAgents -.->|"流式回复推理结果"| BotTypingStreamer
    BotTypingStreamer -.->|"官方 API 流式打字推送"| WeComServer
```

---

## 3. 核心业务流程时序图

### 3.1 外部客户群无感发言全量感知时序图

该时序图展现客户在外部微信客户群中未主动 `@机器人` 时，系统如何通过 `wecom-finance` SDK 轮询解密，并通过专属网关动态发现 `a3` 实例完成回调推送：

```mermaid
sequenceDiagram
    autonumber
    actor Customer as 客户 (外部客户群)
    participant WeCom as 企微云端服务器
    participant WF as wecom-finance (Sidecar)
    participant GW as sidecar/gateway (专属网关)
    participant A3 as a3 主服务 (ai-agent-application)

    Note over WF,GW: 1. 服务发现与寻址
    WF->>GW: GET /api/registry/instances/a3-app<br/>(查询当前健康存活的 a3 实例)
    GW-->>WF: 返回 a3 实例列表 [ { host: "127.0.0.1", port: 3002 } ]

    Note over Customer,WeCom: 2. 客户普通提问 (未 @ 机器人)
    Customer->>WeCom: 发送群消息："请问产品价格是多少？"

    Note over WF,WeCom: 3. 会话内容存档异步拉取与解密
    loop 守护轮询周期 (pollIntervalMs)
        WF->>WeCom: Finance SDK 拉取密文 chatdata (指定游标 seq)
        WeCom-->>WF: 返回加密数据包与随机密钥密文
        WF->>WF: RSA 私钥解密 AES 密钥<br/>AES-256-CBC 解密消息正文
        WF->>WF: 过滤并保存最新已处理 Seq 游标
    end

    Note over WF,A3: 4. 反向感知回调推送
    WF->>A3: POST http://127.0.0.1:3002/api/wecom/finance/callback<br/>Payload: { msgid, sendertime, from, roomid, text: { content } }
    A3-->>WF: HTTP 200 OK (接收成功)

    Note over A3: 5. a3 投入缓冲聚合队列并开启仲裁
```

---

### 3.2 消息缓冲防抖、动态封组与抢话筒仲裁时序图

展示 `a3` 收到群消息后，如何进行四层身份判定、动态防抖封组，并在并发场景下执行话筒争抢与租期释放机制：

```mermaid
sequenceDiagram
    autonumber
    participant Ingress as 消息接入层 (Ws / FinanceCallback)
    participant ID as 成员身份解析器 (MemberIdentityService)
    participant Buf as 缓冲聚合池 (MessageBufferManager)
    participant Timer as 动态防抖定时器 (Debounce Timer)
    participant Mic as 抢话筒仲裁器 (MicrophoneStateArbitrator)
    participant Downstream as 下游调度中心 (Nginx -> Agents Router)

    Ingress->>ID: 传入单条入站消息 (roomId, senderId, text, timestamp)
    ID->>ID: 识别发言者身份 (CUSTOMER / STAFF / BOT / SPECIALIST)
    ID->>Buf: 推入群会话缓冲区 (roomId)
    
    alt 缓冲区当前为空
        Buf->>Timer: 启动防抖定时器 (如 3000ms 动态倒计时)
    else 缓冲区已有消息且未超时
        Buf->>Timer: 重置防抖倒计时 (Debounce Reset)
    end

    alt 定时器倒计时归零 OR 消息堆叠达到 MAX_COUNT
        Timer->>Buf: 触发超时封包事件 (Flush Event)
        Buf->>Buf: 截取并封组消息包 (Seal Grouped Payload)
        Buf->>Mic: 请求获取发言话筒 (acquireMic: roomId, expireSec=60)
        
        alt 话筒已被占用 (例如客服正在处理或前序仍在推理)
            Mic-->>Buf: 获取失败 (MIC_LOCKED / QUEUED)
            Note over Buf: 暂存队列或合并至下一轮处理
        else 话筒抢占成功
            Mic-->>Buf: 获取成功 (MIC_ACQUIRED)
            Buf->>Downstream: 发送标准聚合并发请求 (POST Payload)
            Note over Downstream: Nginx -> Router -> Inner Gateway -> Agents
            Downstream-->>Ingress: 流式响应推理正文 (Stream / Typing)
            Note over Mic: 处理完成或超时触发释放话筒 (releaseMic)
        end
    end
```

---

### 3.3 专属网关服务注册发现 (SRF) 与配置中心 (CC) 动态同步时序图

展现系统启动、心跳维持、运维人员通过 cURL 变更参数及秒级热加载过程：

```mermaid
sequenceDiagram
    autonumber
    actor Admin as 运维管理员 / CI-CD
    participant A3 as a3 主服务 (ai-agent-application)
    participant WF as wecom-finance (Sidecar)
    participant GW as sidecar/gateway (专属网关)
    participant Redis as Redis Pub/Sub (ag:cfg:changed)

    Note over A3,GW: 1. 服务初始化注册
    A3->>GW: POST /api/registry/register<br/>{ instanceId: "a3-1", serviceName: "a3-app", host, port: 3002 }
    WF->>GW: POST /api/registry/register<br/>{ instanceId: "wf-1", serviceName: "wecom-finance", host, port: 3001 }
    GW-->>A3: 注册成功 (租期 30s)
    GW-->>WF: 注册成功 (租期 30s)

    Note over A3,GW: 2. 定期心跳保活 (定时任务 15s)
    loop 每 15 秒心跳保活
        A3->>GW: POST /api/registry/heartbeat { instanceId: "a3-1" }
        GW-->>A3: 200 OK (租期重置为 30s)
    end

    Note over Admin,GW: 3. 动态配置更新 (无 UI 运维)
    Admin->>GW: POST /api/config/wecom-finance/batch<br/>Header: x-gateway-token<br/>Body: { configs: { pollIntervalMs: 2000, batchSize: 200 }, comment: "调优轮询" }
    GW->>GW: 持久化配置至 Redis 存储
    GW->>Redis: PUBLISH ag:cfg:changed { namespace: "wecom-finance", action: "BATCH_SET" }
    GW-->>Admin: 200 OK (批量更新成功)

    Note over Redis,A3: 4. 秒级热加载生效
    Redis-->>A3: 收到变更广播事件
    A3->>A3: 校验 namespace，重新从 Gateway 拉取最新配置热生效
```

---

## 4. 伴生微服务 (Sidecars) 详细剖析与目录索引

本项目采用松耦合但紧密伴生的 Sidecar 模式设计。所有 Sidecar 均可独立启动、独立测试、独立容器化构建，并通过标准 HTTP/REST 与 Redis 与主服务协同。

### 4.1 专属服务网关：[sidecar/gateway](file:///home/hyong/code/ai-agent/ai-agent-application/sidecar/gateway)

#### 4.1.1 架构定位与核心职责
- **a3 专属服务注册中心 (SRF)**：提供微服务实例动态发现、健康状态跟踪、租期管理（默认 30s）与故障实例自动剔除。
- **动态配置中心 (CC)**：提供多命名空间（`default`、`wecom-finance`、`a3-app`）动态参数配置存储；当配置通过 API 写入后，自动通过 Redis Channel `ag:cfg:changed` 广播事件通知，使得 a3 及各组件实现免重启秒级热生效。
- **轻量级鉴权与独立部署**：内置 `x-gateway-token` 鉴权机制（[GatewayAuthGuard](file:///home/hyong/code/ai-agent/ai-agent-application/sidecar/gateway/src/auth/gateway-auth.guard.ts)），兼顾安全与无 UI 运维便捷性。

#### 4.1.2 核心代码目录与模块索引
- 网关启动入口：[src/main.ts](file:///home/hyong/code/ai-agent/ai-agent-application/sidecar/gateway/src/main.ts)
- 服务注册发现模块：[src/registry/](file:///home/hyong/code/ai-agent/ai-agent-application/sidecar/gateway/src/registry)
  - 控制器：[registry.controller.ts](file:///home/hyong/code/ai-agent/ai-agent-application/sidecar/gateway/src/registry/registry.controller.ts)
  - 核心服务：[registry.service.ts](file:///home/hyong/code/ai-agent/ai-agent-application/sidecar/gateway/src/registry/registry.service.ts)
- 动态配置中心模块：[src/config/](file:///home/hyong/code/ai-agent/ai-agent-application/sidecar/gateway/src/config)
  - 控制器：[config.controller.ts](file:///home/hyong/code/ai-agent/ai-agent-application/sidecar/gateway/src/config/config.controller.ts)
  - 核心服务：[config.service.ts](file:///home/hyong/code/ai-agent/ai-agent-application/sidecar/gateway/src/config/config.service.ts)
- 四层身份识别服务：[src/member-identity/member-identity.service.ts](file:///home/hyong/code/ai-agent/ai-agent-application/sidecar/gateway/src/member-identity/member-identity.service.ts)
- 独立 API 接口规范说明书：[sidecar/gateway/doc/API.md](file:///home/hyong/code/ai-agent/ai-agent-application/sidecar/gateway/doc/API.md)

---

### 4.2 企业微信会话存档伴生服务：[sidecar/wecom-finance](file:///home/hyong/code/ai-agent/ai-agent-application/sidecar/wecom-finance)

#### 4.2.1 架构定位与核心职责
- **全量感知外部群消息**：突破企业微信官方普通外部群未 `@机器人` 无法感知的硬性限制，以 7x24 小时独立后台常驻进程拉取企业微信合规会话存档。
- **高性能加解密与驱动抽象**：采用双阶段解密模型（RSA PKCS#1 解密随机密钥 + AES-256-CBC 解密正文）；底层提供 Native C-SDK 驱动与开箱即用的 Mock 模拟器。
- **游标持久化与断点续拉**：[SeqManager](file:///home/hyong/code/ai-agent/ai-agent-application/sidecar/wecom-finance/src/cursor/seq-manager.ts) 保证即便网络抖动或服务重启，也能从最近断点精确拉取，不重不漏。
- **自动寻址与反向回调**：与专属网关集成，动态发现 a3 实例的存活端点并进行 HTTP 反向投递。

#### 4.2.2 核心代码目录与模块索引
- 独立启动入口与守护进程：[src/index.ts](file:///home/hyong/code/ai-agent/ai-agent-application/sidecar/wecom-finance/src/index.ts)
- 会话存档 Worker 守护任务：[src/worker/finance-worker.ts](file:///home/hyong/code/ai-agent/ai-agent-application/sidecar/wecom-finance/src/worker/finance-worker.ts)
- 双阶段加解密工具：[src/crypto/finance-crypto.ts](file:///home/hyong/code/ai-agent/ai-agent-application/sidecar/wecom-finance/src/crypto/finance-crypto.ts)
- Seq 游标管理器：[src/cursor/seq-manager.ts](file:///home/hyong/code/ai-agent/ai-agent-application/sidecar/wecom-finance/src/cursor/seq-manager.ts)
- 驱动抽象层：
  - 通用接口：[src/driver/driver.interface.ts](file:///home/hyong/code/ai-agent/ai-agent-application/sidecar/wecom-finance/src/driver/driver.interface.ts)
  - 本地模拟器：[src/driver/mock-driver.ts](file:///home/hyong/code/ai-agent/ai-agent-application/sidecar/wecom-finance/src/driver/mock-driver.ts)
  - C-SDK 官方原生驱动：[src/driver/c-sdk-driver.ts](file:///home/hyong/code/ai-agent/ai-agent-application/sidecar/wecom-finance/src/driver/c-sdk-driver.ts)
- 独立 API 接口规范说明书：[sidecar/wecom-finance/doc/API.md](file:///home/hyong/code/ai-agent/ai-agent-application/sidecar/wecom-finance/doc/API.md)

---

## 5. 部署与拓扑说明

在生产容器化部署或混合架构部署时，推荐配置如下拓扑：

1. **同主机/Pod Sidecar 模式**：
   - 将 `ai-agent-application`、`sidecar/gateway`、`sidecar/wecom-finance` 作为 Pod 的多个容器协同部署，通过 `localhost` 极速通信，免去公网或复杂内网寻址损耗。
2. **多节点分布式模式**：
   - 依赖集中式 Redis 保证网关注册中心健康表及分布式配置广播实时同步。
   - a3 通过配置环境变量 `GATEWAY_ENABLED=true`、`GATEWAY_URL=http://<gateway-host>:<port>` 接入网关，以无状态模式横向扩容。
