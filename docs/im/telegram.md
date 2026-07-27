---
title: Telegram 接入
nav_title: Telegram
description: 找 BotFather 要一个 Bot Token 填进桌面端，在 Telegram 私聊里点按钮批权限。
order: 2
---

# Telegram 接入

五个平台里接入最快的一个：找 `@BotFather` 要一个 Token，粘进桌面端就完事，权限审批是原生按钮。适合能连上 Telegram 的个人用户。限制是只处理私聊，不处理群组；国内网络下的连通性要你自己解决。

## 创建机器人

在 Telegram 里搜索官方账号 `@BotFather`。

![搜索 BotFather](../images/im/telegram/01-search-botfather.png)

给它发送 `/newbot`。

![发送 newbot 命令](../images/im/telegram/02-newbot-command.png)

按提示走完两步：

1. 取一个机器人名称，例如 `ClaudeCodeHaha机器人`。
2. 取一个用户名，全英文且必须以 `_bot` 结尾，例如 `jiang_cc_hah_bot`。

创建成功后复制 BotFather 返回的**Bot Token**。这枚 Token 等同于机器人的密码，别贴到公开的地方。

![复制 Bot Token](../images/im/telegram/03-bot-token.png)

## 在桌面端填 Token

1. 打开「设置」→「IM 接入」，切到「Telegram」Tab。
2. 把 Bot Token 粘进「Bot Token」。
3. 点「保存」。

![填写 Bot Token](../images/im/telegram/04-fill-bot-token.png)

「允许的用户」可以留空。留空时只有完成配对的人能用。要直接放行已知账号，就填 Telegram 数字用户 ID，多个用逗号分隔。

## 配对

回到页面顶部的「配对管理」，点「生成配对码」，拿到一枚 6 位码。这一步立即生效，不需要再点保存。

![生成配对码](../images/im/telegram/05-generate-pairing-code.png)

在 Telegram 里私聊刚创建的机器人，随便发一条消息，按提示把这枚码发过去。看到配对成功提示就可以开始对话。

![配对成功](../images/im/telegram/06-pair-success.png)

配对码 60 分钟内有效、只能用一次，重新生成后旧码立刻作废。连续输错会被限流，等几分钟再试。

## 支持的命令

- `/start` — 显示帮助和可用命令
- `/help` — 显示当前可用命令
- `/projects` — 列出最近项目并切换
- `/status` — 当前项目、模型、运行状态和任务摘要
- `/new` — 清空当前绑定并重新选择项目
- `/clear` — 清空上下文，保留项目绑定
- `/stop` — 停止本轮生成

## 权限审批与消息表现

Claude 请求敏感权限时，Telegram 里会收到一条带按钮的消息，三个选项分别是允许一次、永久允许同类操作、拒绝。点完结果直接回传给桌面端会话。

回复走一层流式缓冲：思考阶段先发占位消息，正文逐步累积更新，完成后按 Telegram 的长度上限分片发送。

## 本地开发启动

发布版桌面端会自动把 adapter 作为 sidecar 拉起。只有从源码运行或单独调试时才需要手动启动：

```bash
cd adapters
bun install
bun run telegram
```

可选的环境变量覆盖：

```bash
export TELEGRAM_BOT_TOKEN="123456:ABC-DEF..."
export ADAPTER_SERVER_URL="ws://127.0.0.1:3456"
```

## 常见问题

**adapter 启动时报缺少 Token**：`TELEGRAM_BOT_TOKEN` 和 `~/.claude/adapters.json` 里的 `telegram.botToken` 都没生效，回设置页把 Token 填好并保存。

**设置页能打开但机器人没反应**：源码运行时 webapp 只负责写配置，不会自动拉起 `bun run telegram`；发布版桌面端才会通过 sidecar 自动启动。

**发消息提示未授权**：检查是否已生成配对码、码是否还在 60 分钟有效期内、是否发到了正确的机器人私聊里。

**重启后会话没接回来**：检查 `~/.claude/adapter-sessions.json` 能否正常写入，以及桌面端里那条会话是否还在。

## 源码入口

`adapters/telegram/index.ts`，以及 `adapters/common/` 下的 `pairing.ts`、`session-store.ts`、`ws-bridge.ts`、`message-buffer.ts`、`format.ts`。
