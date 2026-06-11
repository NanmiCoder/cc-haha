# WhatsApp 接入

> WhatsApp Adapter 使用 WhatsApp Web linked device 方式接入个人号。实现基于 `@whiskeysockets/baileys`。

## 适用场景

WhatsApp 方案适合用自己的 WhatsApp 个人号在私聊里远程驱动 Claude Code Haha。当前实现只处理个人私聊，不处理群聊、频道、状态广播。

实现入口：`adapters/whatsapp/index.ts`

## 它不是“创建机器人”

当前实现走的是 WhatsApp Web 的 linked device 方式，不是官方 WhatsApp Business Platform / Cloud API。

这意味着：

- 不需要在 Meta for Developers 创建 App
- 不需要 WhatsApp Business Account（WABA）
- 不需要 Phone Number ID、WABA ID、Access Token
- 不需要配置 Webhook callback URL
- 不需要申请或审核 message template

它的工作方式更接近“把 Claude Code Haha 作为一台已登录的 WhatsApp Web 设备挂到你的个人 WhatsApp 账号上”：

1. 桌面端用 Baileys 生成 WhatsApp Web 登录二维码
2. 你用手机 WhatsApp 的 `Linked devices` 扫码
3. 本机保存 WhatsApp Web auth state
4. adapter 监听这个账号收到的个人私聊消息
5. 已授权用户发来的消息会被转成 Claude Code Haha session 输入
6. Claude 的回复再由这个 WhatsApp 账号发回同一个私聊

因此，WhatsApp 这里没有 Telegram BotFather、飞书机器人、钉钉 Stream 机器人那种“后台创建 bot”的概念。对用户来说，对话对象就是你扫码绑定的那个 WhatsApp 账号本身。

如果后续要做面向客户服务、模板消息、官方 SLA、Webhook、规模化群发或合规商业账号接入，那是另一套官方 Cloud API 方案，需要单独实现，至少会涉及 Meta App、WABA、业务手机号、永久 access token、Webhook 和模板消息。参考官方资料：

- [WhatsApp Linked Devices 帮助](https://faq.whatsapp.com/1317564962315842/)
- [Meta WhatsApp Cloud API Overview](https://developers.facebook.com/docs/whatsapp/cloud-api/overview)
- [Meta WhatsApp Cloud API Get Started](https://developers.facebook.com/docs/whatsapp/cloud-api/get-started)

## 1. 在桌面端扫码绑定

打开桌面端 `设置 -> IM 接入 -> WhatsApp`：

1. 点击「扫码绑定」
2. 在手机 WhatsApp 打开 `Settings -> Linked devices`
3. 扫描桌面端显示的二维码
4. 等待页面提示绑定成功

绑定成功后，桌面端会把 Baileys auth state 保存到本机，并重启 adapter sidecar。

默认 auth 目录：

```text
~/.claude/whatsapp-auth/default
```

配置记录写在：

```json
{
  "whatsapp": {
    "accountJid": "15551234567@s.whatsapp.net",
    "authDir": "~/.claude/whatsapp-auth/default",
    "allowedUsers": [],
    "pairedUsers": []
  }
}
```

## 2. 生成配对码

扫码只绑定 WhatsApp Web 账号能力，不等于授权所有聊天用户。

在 `IM 接入` 页点击「生成配对码」，然后用需要授权的 WhatsApp 私聊给当前账号发送该配对码。配对成功后，这个 WhatsApp JID 会写入 `whatsapp.pairedUsers`。

也可以直接在 `Allowed Users` 里填写允许的 WhatsApp JID，例如：

```text
15551234567@s.whatsapp.net
```

## 3. 启动 adapter

发布版桌面端会自动拉起 adapter sidecar。本地开发或单独调试时：

```bash
cd adapters
bun install
bun run whatsapp
```

## 支持的命令

- `/start` 或 `/help` — 显示帮助和可用命令
- `/projects` — 切换项目，重新显示最近项目列表
- `/status` — 查看当前会话的项目、模型和运行状态
- `/clear` — 清空当前会话上下文，保留项目绑定
- `/new [项目]` — 新建会话或切换项目
- `/stop` — 向当前 session 发送 `stop_generation`

## 权限审批

WhatsApp 没有使用按钮审批。收到权限请求后，按消息提示回复：

- `1` 或 `/allow <requestId>` — 允许一次
- `2` 或 `/always <requestId>` — 永久允许
- `3` 或 `/deny <requestId>` — 拒绝

## 返回消息的表现

WhatsApp adapter 不依赖 WhatsApp message edit 做 token 级流式更新。它会：

- thinking 时发送一个简短状态提示
- 完成后把正文按约 4000 字分片发送
- 识别 Agent 输出里的 markdown 图片引用并作为图片消息发送

## 环境变量覆盖（可选）

```bash
export WHATSAPP_AUTH_DIR="$HOME/.claude/whatsapp-auth/default"
export WHATSAPP_ACCOUNT_JID="15551234567@s.whatsapp.net"
export ADAPTER_SERVER_URL="ws://127.0.0.1:3456"
```

## 常见问题

### adapter 启动时报没有绑定账号

先在桌面端 WhatsApp 标签页扫码绑定。`bun run whatsapp` 不会单独弹出二维码。

### 绑定后发消息提示未授权

扫码绑定的是 WhatsApp Web 账号，不是用户授权。还需要在桌面端生成配对码，并用 WhatsApp 私聊发送给当前账号。

### WhatsApp 提示已登出

在桌面端 WhatsApp 标签页解除绑定后重新扫码。解除绑定会删除本机 WhatsApp auth state。

## 源码入口

- `adapters/whatsapp/index.ts`
- `adapters/whatsapp/protocol.ts`
- `adapters/whatsapp/session.ts`
- `adapters/whatsapp/media.ts`
- `adapters/common/pairing.ts`
- `adapters/common/session-store.ts`
- `adapters/common/ws-bridge.ts`
