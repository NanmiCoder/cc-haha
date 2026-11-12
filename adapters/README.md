# Claude Code IM Adapters

This directory contains only the IM Adapter runtime code.

User documentation has moved to `docs/` and follows the Desktop Webapp configuration flow:

- `docs/im/index.md`
- `docs/im/wechat.md`
- `docs/im/dingtalk.md`
- `docs/im/whatsapp.md`
- `docs/im/telegram.md`
- `docs/im/feishu.md`
- `docs/im/wecom.md`
- `docs/im/qq.md`
- `docs/im/slack.md`

## Current Design Summary

The actual pipeline is:

```text
Desktop Webapp Settings
  -> /api/adapters
  -> ~/.claude/adapters.json
  -> adapters/<platform>/index.ts
  -> /api/sessions + /ws/:sessionId
  -> Claude Code session
```

Two things to note:

- IM configuration and pairing both live in the Desktop Webapp under `Settings -> IM Integration`
- When running from source, the Webapp does not start Adapter processes automatically; you still need to run `bun run <platform>` manually. The packaged desktop app launches them as sidecars

## Quick Start

```bash
cd adapters
bun install
bun run telegram
# or feishu / wechat / dingtalk / whatsapp / wecom / qq / slack
```

## Development

### Running Tests

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

### Directory Layout

```text
adapters/
├── common/
│   ├── chat-runtime.ts    # Cross-platform session loop (pairing / commands / server stream -> ChatPort)
│   └── attachment/        # Cross-platform attachment utilities (types / limits / store / image-watcher / mime)
├── telegram/
│   └── media.ts           # TelegramMediaService (grammy Bot API wrapper)
├── feishu/
│   ├── media.ts           # FeishuMediaService (@larksuiteoapi/node-sdk wrapper)
│   └── extract-payload.ts # Inbound im.message.receive_v1 event parsing
├── wechat/
│   ├── protocol.ts        # WeChat iLink QR login / getupdates / sendmessage protocol wrapper
│   └── index.ts           # WeChat text chat Adapter
├── dingtalk/
│   ├── helpers.ts         # DingTalk Stream message parsing and session keys
│   └── index.ts           # DingTalk QR binding / Stream text chat Adapter
├── whatsapp/
│   ├── session.ts         # Baileys socket / auth state wrapper
│   ├── protocol.ts        # WhatsApp QR login / unbind protocol wrapper
│   └── index.ts           # WhatsApp Web direct-message Adapter
├── wecom/
│   ├── qr-auth.ts         # WeCom smart bot creation via QR scan
│   ├── extract-payload.ts # Inbound message parsing (text / voice / mixed / quote)
│   └── index.ts           # WeCom long-connection Adapter (streaming messages)
├── qq/
│   ├── qr-auth.ts         # QQ Open Platform QR authorization
│   ├── extract-payload.ts # Inbound C2C message parsing
│   └── index.ts           # QQ WebSocket gateway Adapter (stream_messages)
├── slack/
│   ├── api.ts             # Slack Web API wrapper (messages / files / Socket connection)
│   ├── socket-mode.ts     # Socket Mode long connection
│   ├── manifest.ts        # App manifest and one-click creation link
│   └── index.ts           # Slack direct-message Adapter (in-place edits)
├── package.json
├── tsconfig.json
└── README.md
```

## Sending and Receiving Attachments

Each Adapter supports images/files in both directions, passed through to the main process via the same `AttachmentRef` protocol the Desktop app uses.

**Inbound (user → Claude):**

- Feishu: images (jpg/png/gif/webp/heic), documents (doc/xls/ppt/pdf, etc.), img/file elements inside post rich text
- Telegram: photo, document, video, audio, voice
- WhatsApp: image, document, video, audio, sticker
- WeCom: image, file, image inside mixed (decrypted with aeskey after download); voice is transcribed to text by the platform
- QQ: attachments in the event; voice uses the platform's ASR text, audio is not downloaded
- Slack: files in direct messages (files.slack.com only, downloaded with the Bot Token)

Downloads land in `~/.claude/im-downloads/{platform}/{sessionId}/` and are garbage-collected after 24 hours (orphaned `.part` files time out after 10 minutes). Size limits: ≤10 MB per image, ≤30 MB per file; anything over the limit is rejected with a notice in the IM chat.

**Outbound (Claude → user):**

Markdown image references `![alt](path|url|data:)` in the Agent's streamed text are detected by `ImageBlockWatcher`, uploaded to the IM platform, and sent as standalone image messages:

- Feishu: sent individually via `im.message.create(msg_type='image')` (embedding in cards is a future improvement)
- Telegram: sent individually via `bot.api.sendPhoto(InputFile)`
- WhatsApp: sent individually via Baileys `sendMessage({ image })`
- WeCom: sent individually via `uploadMedia` + `sendMediaMessage`
- QQ: sent individually via `sendMedia(MediaFileType.IMAGE)`
- Slack: uploaded via the three-step `files.getUploadURLExternal` flow, then posted to the direct message

Non-image outbound files (pdf/zip etc. produced by the Agent) are not supported yet.

Design details: `docs/superpowers/specs/2026-04-11-im-attachment-support-design.md`.
