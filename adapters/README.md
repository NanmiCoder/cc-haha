# Claude Code IM Adapters

当前目录只放 IM Adapter 运行时代码。

用户文档已经迁移到 `docs/`，并且以 Desktop Webapp 配置流程为准：

- `docs/im/index.md`
- `docs/im/wechat.md`
- `docs/im/dingtalk.md`
- `docs/im/whatsapp.md`
- `docs/im/telegram.md`
- `docs/im/feishu.md`
- `docs/im/wecom.md`
- `docs/im/qq.md`
- `docs/im/slack.md`

## 当前方案摘要

当前真实链路是：

```text
Desktop Webapp Settings
  -> /api/adapters
  -> ~/.claude/adapters.json
  -> adapters/<platform>/index.ts
  -> /api/sessions + /ws/:sessionId
  -> Claude Code session
```

注意两点：

- IM 配置和配对都在 Desktop Webapp 的 `Settings -> IM 接入`
- 从源码运行时 Webapp 不会自动启动 Adapter 进程，仍需手动运行 `bun run <platform>`；发布版桌面端会把它们作为 sidecar 拉起

## 快速启动

```bash
cd adapters
bun install
bun run telegram
# 或 feishu / wechat / dingtalk / whatsapp / wecom / qq / slack
```

## 开发

### 运行测试

```bash
cd adapters
bun test
bun test common/
bun test telegram/
bun test feishu/
bun test wechat/
bun test dingtalk/
bun test whatsapp/
bun test wecom/
bun test qq/
bun test slack/
```

### 目录结构

```text
adapters/
├── common/
│   ├── chat-runtime.ts    # 跨平台会话循环(配对 / 命令 / 服务端流 -> ChatPort)
│   └── attachment/        # 跨平台附件工具(types / limits / store / image-watcher / mime)
├── telegram/
│   └── media.ts           # TelegramMediaService(grammy Bot API 封装)
├── feishu/
│   ├── media.ts           # FeishuMediaService(@larksuiteoapi/node-sdk 封装)
│   └── extract-payload.ts # 入站 im.message.receive_v1 事件解析
├── wechat/
│   ├── protocol.ts        # 微信 iLink QR 登录 / getupdates / sendmessage 协议封装
│   └── index.ts           # 微信文本聊天 Adapter
├── dingtalk/
│   ├── helpers.ts         # 钉钉 Stream 消息解析与会话键
│   └── index.ts           # 钉钉扫码绑定 / Stream 文本聊天 Adapter
├── whatsapp/
│   ├── session.ts         # Baileys socket / auth state 封装
│   ├── protocol.ts        # WhatsApp QR 登录 / 解绑协议封装
│   └── index.ts           # WhatsApp Web 私聊 Adapter
├── wecom/
│   ├── qr-auth.ts         # 企业微信智能机器人扫码创建
│   ├── extract-payload.ts # 入站消息解析(text / voice / mixed / quote)
│   └── index.ts           # 企业微信长连接 Adapter(流式消息)
├── qq/
│   ├── qr-auth.ts         # QQ 开放平台扫码授权
│   ├── extract-payload.ts # 入站 C2C 消息解析
│   └── index.ts           # QQ WebSocket 网关 Adapter(stream_messages)
├── slack/
│   ├── api.ts             # Slack Web API 封装(消息 / 文件 / Socket 连接)
│   ├── socket-mode.ts     # Socket Mode 长连接
│   ├── manifest.ts        # 应用清单与一键创建链接
│   └── index.ts           # Slack 私信 Adapter(原地编辑)
├── package.json
├── tsconfig.json
└── README.md
```

## 附件收发

各 Adapter 支持双向图片/文件,和 Desktop 端走同一套 `AttachmentRef` 协议透传给主进程。

**入站(用户 → Claude):**

- 飞书: 图片(jpg/png/gif/webp/heic)、文档(doc/xls/ppt/pdf 等)、post 富文本里的 img/file 元素
- Telegram: photo、document、video、audio、voice
- WhatsApp: image、document、video、audio、sticker
- 企业微信: image、file、mixed 里的 image(下载后按 aeskey 解密);voice 由平台转写成文本
- QQ: 事件里的 attachments;voice 用平台的 ASR 文本,不下载音频
- Slack: 私信里的 files(仅 files.slack.com,带 Bot Token 下载)

下载落地到 `~/.claude/im-downloads/{platform}/{sessionId}/`,24 小时后自动 GC(`.part` 孤文件 10 分钟超时)。大小限制:单张图 ≤10 MB、单个文件 ≤30 MB,超限直接拒收并在 IM 里提示。

**出站(Claude → 用户):**

Agent 流式文本里的 markdown 图片引用 `![alt](path|url|data:)` 会被 `ImageBlockWatcher` 识别、上传到 IM 平台,作为独立图片消息发出:

- 飞书: `im.message.create(msg_type='image')` 单发(card 内嵌是后续优化)
- Telegram: `bot.api.sendPhoto(InputFile)` 单发
- WhatsApp: Baileys `sendMessage({ image })` 单发
- 企业微信: `uploadMedia` + `sendMediaMessage` 单发
- QQ: `sendMedia(MediaFileType.IMAGE)` 单发
- Slack: `files.getUploadURLExternal` 三步上传后发进私信

非图片类出站(Agent 产的 pdf/zip 等)暂不支持。

设计细节: `docs/superpowers/specs/2026-04-11-im-attachment-support-design.md`。
