---
title: Slack 接入
nav_title: Slack
description: 用预填好的应用清单创建 Slack App，走 Socket Mode 在私信里驱动桌面端。
order: 8
---

# Slack 接入

适合海外团队和已经在用 Slack 的人。Slack 没有扫码流程，最接近的是**应用清单**：桌面端把权限、事件订阅和 Socket Mode 都预填好，你只要打开链接确认创建，再把两枚 Token 粘回来。

用 Socket Mode 的原因和飞书、企业微信、QQ 走长连接一样：本机不需要公网地址，Slack 不用回调到你的电脑。

限制：只处理私信（DM），不处理频道；权限审批是文本命令。

## 创建 Slack 应用

1. 打开「设置」→「IM 接入」，切到「Slack」Tab。
2. 点「用清单创建应用」。这会打开 Slack 的创建页，并把清单预填进去；页面上的「查看应用清单 JSON」可以展开同一份内容，方便手动粘贴。
3. 选一个工作区，确认清单后创建应用。
4. 在应用的「Install App」里把它安装到工作区，复制 **Bot User OAuth Token**（`xoxb-` 开头）。
5. 回到「Basic Information」→「App-Level Tokens」，生成一枚带 `connections:write` 权限的 Token（`xapp-` 开头）。
6. 把两枚 Token 分别填进桌面端的「Bot Token」和「App-Level Token」，点「保存」。

清单请求的权限就是适配器实际会调用的那几个，没有多余项：

| Scope | 用来做什么 |
|---|---|
| `chat:write` | 发消息、原地更新同一条消息 |
| `im:history` | 接收 `message.im` 私信事件 |
| `files:read` | 下载你发来的附件 |
| `files:write` | 把 Agent 产出的图片发回来 |
| `users:read` | 在「已配对用户」里显示昵称而不是一串 ID |

## 配对

回到页面顶部的「配对管理」，点「生成配对码」，拿到一枚 6 位码。这一步立即生效，不需要再点保存。

在 Slack 里给这个 App 发私信，把这枚码发过去。看到配对成功提示就可以开始对话。

配对码 60 分钟内有效、只能用一次，重新生成后旧码立刻作废。同一个用户 5 分钟内连续输错 5 次会被限流。

「允许的用户」可以留空。留空时只有完成配对的人能用。要直接放行已知同事，就填 Slack 用户 ID（`U` 开头），多个用逗号分隔。

## 支持的命令

- `/help` 或 `帮助` — 列出当前可用命令
- `/status` 或 `状态` — 当前项目、模型、运行状态
- `/projects` 或 `项目列表` — 列出最近项目并切换
- `/new` 或 `新会话` — 开一条新会话，可带项目编号、名称或绝对路径
- `/clear` 或 `清空` — 清空上下文，保留项目绑定
- `/stop` 或 `停止` — 停止本轮生成
- 权限审批：回复 `1` 允许一次、`2` 永久允许、`3` 拒绝，也可以用 `/allow <id>`、`/always <id>`、`/deny <id>`

这些是当作普通消息发的文本，不是 Slack 的斜杠命令（清单里没有申请 slash command，所以不会和工作区里已有的命令冲突）。

## 消息表现

回复先发一条消息，随后原地编辑同一条：编辑按每秒一次左右节流，避免撞上 Slack 的 `chat.update` 限流。正文超过单条长度上限时，前面的部分定稿，剩下的接在新消息里继续更新。

你发来的附件会用 Bot Token 从 `files.slack.com` 下载（只认这个域名），图片直接进 Agent，其他文件落到 `~/.claude/im-downloads/slack/`。Agent 输出里引用的本地图片（限当前会话工作目录内）会通过 Slack 的外部上传接口发回私信。

## Agent 能力与边界

Slack 不是一套独立的问答模型。普通消息进入的是当前项目的同一条 Claude Code Agent 会话，因此会延续多轮上下文，并能使用该会话已经加载的文件、终端、Git、Skills 和 MCP 工具。

这意味着配对成功的账号获得的是当前项目里的完整 Agent 能力，权限确认只是操作闸门，不是操作系统沙箱。不要把 App 装进不可信的工作区，也不要在聊天里安装未经本机审核的 Skill、Plugin 或 MCP。

Adapter 只接受已配对或在允许列表中的私信账号；频道消息、消息编辑、删除以及机器人自己发的消息都会被丢弃。

## 本地开发启动

发布版桌面端会自动把 adapter 作为 sidecar 拉起。只有从源码运行或单独调试时才需要手动启动：

```bash
cd adapters
bun install
bun run slack
```

可选的环境变量覆盖：

```bash
export SLACK_BOT_TOKEN="xoxb-..."
export SLACK_APP_TOKEN="xapp-..."
export ADAPTER_SERVER_URL="ws://127.0.0.1:3456"
```

## 常见问题

**adapter 启动就报 `invalid_auth`**：Bot Token 填错或应用还没安装到工作区，回 Slack 的「Install App」页重新复制一次。

**日志里反复出现 Socket Mode 重连**：App-Level Token 少了 `connections:write` 权限，或者这枚 Token 已经被撤销。重新生成一枚填进来。

**私信没反应**：确认清单里的 `message.im` 事件订阅还在，并且 App 的「App Home」里允许了 Messages Tab。手动改过应用配置的话，对照上面的权限表检查一遍。

**附件收不到**：缺 `files:read`，这个权限只有重新安装应用才会生效。

**发消息提示未授权**：检查是否已生成配对码、码是否还在 60 分钟有效期内、发的是不是当前这一枚。

## 源码入口

`adapters/slack/index.ts`（运行时）、`adapters/slack/api.ts`（Web API 封装）、`adapters/slack/socket-mode.ts`（长连接）、`adapters/slack/manifest.ts`（应用清单）、`adapters/slack/extract-payload.ts`（入站事件过滤），以及 `adapters/common/chat-runtime.ts` 这套跨平台会话循环。
