# Claude Code IM Adapters

当前目录只放 IM Adapter 运行时代码。

用户文档已经迁移到 `docs/`，并且以 Desktop Webapp 配置流程为准：

- `docs/im/index.md`
- `docs/im/telegram.md`
- `docs/im/feishu.md`

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
- Webapp 不会自动启动 Adapter 进程，仍需手动运行 `bun run telegram` 或 `bun run feishu`

## 快速启动

```bash
cd adapters
bun install
bun run telegram
# 或
bun run feishu
```

## 开发

### 运行测试

```bash
cd adapters
bun test
bun test common/
bun test telegram/
bun test feishu/
```

### 目录结构

```text
adapters/
├── common/
│   └── attachment/        # 跨平台附件工具(types / limits / store / image-watcher)
├── telegram/
│   └── media.ts           # TelegramMediaService(grammy Bot API 封装)
├── feishu/
│   ├── media.ts           # FeishuMediaService(@larksuiteoapi/node-sdk 封装)
│   └── extract-payload.ts # 入站 im.message.receive_v1 事件解析
├── package.json
├── tsconfig.json
└── README.md
```

## 附件收发

两个 Adapter 都支持双向图片/文件,和 Desktop 端走同一套 `AttachmentRef` 协议透传给主进程。

**入站(用户 → Claude):**

- 飞书: 图片(jpg/png/gif/webp/heic)、文档(doc/xls/ppt/pdf 等)、post 富文本里的 img/file 元素
- Telegram: photo、document、video、audio、voice

下载落地到 `~/.claude/im-downloads/{platform}/{sessionId}/`,24 小时后自动 GC(`.part` 孤文件 10 分钟超时)。大小限制:单张图 ≤10 MB、单个文件 ≤30 MB,超限直接拒收并在 IM 里提示。

**出站(Claude → 用户):**

Agent 流式文本里的 markdown 图片引用 `![alt](path|url|data:)` 会被 `ImageBlockWatcher` 识别、上传到 IM 平台,作为独立图片消息发出:

- 飞书: `im.message.create(msg_type='image')` 单发(card 内嵌是后续优化)
- Telegram: `bot.api.sendPhoto(InputFile)` 单发

非图片类出站(Agent 产的 pdf/zip 等)暂不支持。

设计细节: `docs/superpowers/specs/2026-04-11-im-attachment-support-design.md`。
