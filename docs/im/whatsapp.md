---
title: WhatsApp 接入
nav_title: WhatsApp
description: 用手机 WhatsApp 的「已关联设备」扫码，把桌面端挂成一台已登录的 Web 设备。
order: 5
---

# WhatsApp 接入

适合海外用户：不需要 Meta 开发者账号，扫一次码就能用自己的 WhatsApp 个人号远程驱动桌面端。代价是它走的是 WhatsApp Web 的关联设备登录，不是官方 Cloud API，所以没有官方 SLA、模板消息和群发能力；只处理个人私聊，不处理群组、频道和状态。权限审批靠回复文本。

## 它不是「创建一个机器人」

这条链路的本质，是把桌面端挂成你 WhatsApp 账号下的一台已登录 Web 设备。因此不需要在 Meta for Developers 建 App，不需要 WhatsApp Business Account，也不需要 Phone Number ID、Access Token、Webhook 回调地址和消息模板审核。

对面的人看到的对话对象，就是你扫码绑定的那个 WhatsApp 账号本身，不是一个另外创建的 bot。

如果之后要做客服、模板消息、官方 SLA 或规模化群发，那是另一套官方 Cloud API 方案，需要单独实现。参考[Linked Devices 帮助](https://faq.whatsapp.com/1317564962315842/)和[WhatsApp Cloud API 概览](https://developers.facebook.com/docs/whatsapp/cloud-api/overview)。

## 扫码绑定

1. 打开「设置」→「IM 接入」，切到「WhatsApp」Tab。
2. 点「扫码绑定」。
3. 在手机 WhatsApp 里打开「设置」→「已关联设备」。
4. 扫描桌面端显示的二维码。
5. 等页面状态变成「WhatsApp 已绑定」。

绑定成功后登录状态会保存到本机并自动重启 adapter，不需要再点「保存」。默认目录：

```text
~/.claude/whatsapp-auth/default
```

这个目录等同于一份可直接收发消息的登录凭据，不要外传、不要提交进仓库。

## 授权具体用户

扫码只是把账号挂上来，不等于放行所有联系人。

1. 回到页面顶部的「配对管理」，点「生成配对码」。
2. 用需要授权的那个 WhatsApp 账号，私聊你刚绑定的账号，把这枚 6 位码发过去。
3. 配对成功后这个 JID 会被记进本机授权名单。

也可以直接把已知 JID 填进「允许的用户」，格式是国家码加手机号，例如：

```text
15551234567@s.whatsapp.net
```

配对码 60 分钟内有效、只能用一次，重新生成后旧码立刻作废。

## 支持的命令

- `/start` 或 `/help` — 显示帮助和可用命令
- `/projects` — 列出最近项目并切换
- `/status` — 当前项目、模型和运行状态
- `/new [项目]` — 开新会话或切换项目
- `/clear` — 清空上下文，保留项目绑定
- `/stop` — 停止本轮生成

## 权限审批与消息表现

WhatsApp 没有可点的按钮，权限请求按消息里的提示回复：

- `1` 或 `/allow <requestId>` — 允许这一次
- `2` 或 `/always <requestId>` — 永久允许同类请求
- `3` 或 `/deny <requestId>` — 拒绝

回复方式上，adapter 不靠反复编辑同一条消息做逐字流式：思考阶段发一条简短状态提示，完成后把正文按长度上限分片发送；Agent 输出里的 markdown 图片引用会被识别成图片消息发出。

## 解除绑定

在 WhatsApp Tab 点「解除 WhatsApp 绑定」，会删掉本机保存的登录状态，之后要重新扫码。只想撤销某一个人，就在「已配对用户」列表里点那个人右侧的「解绑」，账号本身的关联不受影响。

## 本地开发启动

发布版桌面端会自动把 adapter 作为 sidecar 拉起。只有从源码运行或单独调试时才需要手动启动：

```bash
cd adapters
bun install
bun run whatsapp
```

可选的环境变量覆盖：

```bash
export WHATSAPP_AUTH_DIR="$HOME/.claude/whatsapp-auth/default"
export WHATSAPP_ACCOUNT_JID="15551234567@s.whatsapp.net"
export ADAPTER_SERVER_URL="ws://127.0.0.1:3456"
```

## 常见问题

**adapter 启动时报没有绑定账号**：先在桌面端完成扫码，`bun run whatsapp` 本身不会弹二维码。

**绑定后发消息提示未授权**：扫码绑的是账号，不是用户授权。还要生成配对码，并用要授权的那个 WhatsApp 私聊发过来。

**WhatsApp 提示已登出**：在设置页解除绑定后重新扫码。手机端在「已关联设备」里移除这台设备也会导致登出。

## 源码入口

`adapters/whatsapp/` 下的 `index.ts`、`protocol.ts`、`session.ts`、`media.ts`，以及 `adapters/common/` 下的 `pairing.ts`、`session-store.ts`、`ws-bridge.ts`。
