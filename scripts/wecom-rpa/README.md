# 企微外部群 RPA 代发（Windows）

企业微信官方接口（智能机器人长连接）**无法向外部客户群发消息**。本目录的 RPA 程序运行在一台登录了企业微信 PC 客户端的 Windows 机器上，模拟人工操作把智能体的回复发进外部群。

## 架构

```
外部群消息 ──会话内容存档──▶ a3-finance-prod (sidecar)
                                   │ POST /api/admin/wecom/finance-inbound (x-sidecar-token)
                                   ▼
                            a3-app-prod  缓冲 / 封组 / 话筒
                                   │
                                   ▼
                            a3-core-prod 意图 / 检索 / 生成回复
                                   │
                                   ▼
            WecomChannelAdapter ── roomid 解析为群名称 ──▶ RPA  POST :5005/api/rpa/send
                                                              │ Ctrl+F 搜索群名 → 点击输入框 → 粘贴 → 回车
                                                              ▼
                                                           外部群
```

- **收消息**：由会话内容存档 sidecar 负责，RPA 默认**不抓取消息**（`inbound_enabled=false`），避免同一条消息被处理两次。
- **发消息**：后端把外部群 roomid（`wr...`）解析成企微客户端中可搜索的群名称，交给 RPA 发送。

## 后端配置（`ai-agent-application/.env.prod`）

| 变量 | 说明 |
|---|---|
| `RPA_SEND_URL` | RPA 发送接口，如 `http://49.232.34.143:5005/api/rpa/send` |
| `RPA_ROOM_TITLES` | 手工映射，JSON：`{"wrXXXX":"群名称"}`；优先级最高，**未命名的群必须配** |
| `WECOM_CONTACT_SECRET` | （可选）「客户联系」Secret，配置后自动调 `externalcontact/groupchat/get` 获取群名称；需在企微后台把服务器 IP 加入可信 IP |
| `WECOM_RPA_BOT_USER_IDS` | RPA 代发账号的企微 userid（逗号分隔），其消息按机器人处理，不抢话筒 |
| `WATCHDOG_TIMEOUT_MS` | 在途超时阈值，RPA 发送约 4s，建议 `30000`，否则会误发「网络繁忙」兜底话术 |

> 未命名的外部群，接口返回的群名称为空（客户端显示的是成员名拼接），只能用 `RPA_ROOM_TITLES` 手工映射，或者先给群命名。

## Windows 部署

1. 安装 Python 3.11，执行 `install.bat` 安装依赖（`uiautomation pyperclip requests flask`）。
2. 登录企业微信 PC 客户端（代发账号），窗口保持打开、不要最小化。
3. 防火墙放行 5005 入站，来源只允许后端服务器 IP：
   ```powershell
   New-NetFirewallRule -DisplayName "WecomRPA5005" -Direction Inbound -Protocol TCP -LocalPort 5005 -RemoteAddress 124.222.117.150 -Action Allow
   ```
   云服务器安全组同样只对后端服务器 IP 放行 TCP 5005。
4. 运行：`python rpa_agent.py`，看到 `send-only mode` 和 `RPA HTTP server listening on port: 5005` 即就绪。

## config.json

| 字段 | 说明 |
|---|---|
| `inbound_enabled` | 是否抓取消息，默认 `false` |
| `sidecar_token` | 仅 `inbound_enabled=true` 时需要；**不要提交真实值** |
| `self_names` | 代发账号显示名，抓取时跳过自己的消息 |
| `input_x_ratio` / `input_y_ratio` | 输入框相对窗口的点击位置，默认 `0.62` / `0.90`，点不中时调整 |
| `search_wait_sec` | 搜索后等待结果的秒数，默认 `1.2` |

## 注意事项

- 文件需保持纯 ASCII（中文用 `\uXXXX` 转义），Windows 默认 GBK 代码页会破坏 UTF-8 中文。
- RPA 发送期间不要操作该 Windows 机器的鼠标键盘。
- 自检：`curl http://127.0.0.1:5005/health` 返回 `{"status":"ok","wecom_connected":true}`。
