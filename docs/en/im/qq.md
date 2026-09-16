---
title: QQ Integration
nav_title: QQ
description: Scan a QR code in Settings to authorize a QQ bot, then drive the Desktop app from a private chat with streaming replies.
order: 7
---

# QQ Integration

For individuals on QQ. Select **Scan to Bind** in Settings, scan with the QQ mobile app, and the AppID and AppSecret land in local configuration — no manual app creation on the QQ Open Platform. Messages travel over the official WebSocket gateway, so your machine needs no public address.

Limits: private (C2C) chats only, no groups or guilds; permission approval is a text reply.

## Authorize the bot by scanning

1. Open **Settings → IM Adapters** and switch to the **QQ** tab.
2. Select **Scan to Bind**. A QR code appears.
3. Scan it with the QQ mobile app and confirm the authorization.
4. On success the AppID and AppSecret are written to `~/.claude/adapters.json` and the adapter restarts.

The code rotates on its own when it expires, and the image on screen refreshes with it. Once bound, the button becomes **Scan Again** and an **Unbind bot account** button appears next to it.

This step only gives the Desktop app the bot's credentials. It does **not** authorize anyone — that is what pairing below decides.

## Pairing

Back at the top of the page, under **Pairing**, select **Generate Code** to get a six-character code. This takes effect immediately; no **Save** is needed.

Send that code to the newly authorized bot in a private QQ chat. Once pairing is confirmed, anything you type goes to Claude Code.

A code is valid for 60 minutes, works once, and is invalidated the moment a new one is generated. Five failed attempts within five minutes trigger rate limiting.

**Allowed Users** can stay empty, in which case only paired accounts can use the bot. To allow known accounts directly, enter their QQ `openid` values separated by commas. A QQ `openid` is a per-bot identifier, not a QQ number.

## Supported commands

- `/help` or `帮助` — list the available commands
- `/status` or `状态` — current project, model, and run state
- `/projects` or `项目列表` — list recent projects and switch
- `/new` or `新会话` — start a fresh session, optionally with an index, name, or absolute path
- `/clear` or `清空` — clear the context, keep the project binding
- `/stop` or `停止` — stop the current turn
- Permission approval: reply `1` to allow once, `2` to allow for the session, `3` to deny; `/allow <id>`, `/always <id>`, and `/deny <id>` work too

## How messages look

Replies use QQ stream messages (`stream_messages`): one message refreshes as the answer is generated, then settles. That API is private-chat only; if a turn has no usable reply anchor, the adapter falls back to ordinary chunked messages instead of dropping content.

A typing indicator is sent while Claude is thinking or running tools. Inbound images and files are downloaded into `~/.claude/im-downloads/qq/` and forwarded as attachments; voice notes use QQ's own transcript rather than downloading the audio. Local images referenced in the Agent's output (restricted to the current session's working directory) are uploaded and sent as separate image messages.

## Agent capability and boundaries

QQ is not a separate question-and-answer model. Messages enter the same Claude Code Agent session as the current project, so they continue the multi-turn context and can use the files, terminal, Git, Skills, and MCP tools that session already has.

That means a paired account holds the full Agent capability of the current project. Permission confirmation is a gate on individual operations, not an OS sandbox. Do not hand the bot to people you do not trust, and do not install unreviewed Skills, plugins, or MCP servers from chat.

The adapter accepts only paired or allow-listed private chats, and project listing and name matching stay inside **Allowed project directories**.

## Running it locally

Release builds start the adapter as a sidecar automatically. Manual startup is only needed when running from source:

```bash
cd adapters
bun install
bun run qq
```

Optional environment overrides:

```bash
export QQ_APP_ID="xxx"
export QQ_APP_SECRET="xxx"
export ADAPTER_SERVER_URL="ws://127.0.0.1:3456"
```

## Troubleshooting

**The QR code never appears.** Scanning goes through the QQ Open Platform; confirm your machine can reach it. The request times out after 20 seconds, so try again.

**Scanned successfully but the bot stays silent.** Confirm the Desktop app is still running and that the **QQ** tab shows an AppID. Credentials are written the moment the scan succeeds, and the adapter restarts on its own.

**Messages report "unauthorized".** Check that a pairing code was generated, that it is still inside its 60-minute window, and that you sent the current one.

**Mentioning the bot in a group does nothing.** That is intended: only private chats are handled. Pairing authorizes one person, and answering in a group would extend that authorization to everyone in it.

## Source entry points

`adapters/qq/index.ts` (runtime), `adapters/qq/qr-auth.ts` (scan authorization), `adapters/qq/extract-payload.ts` (inbound parsing), plus the shared session loop in `adapters/common/chat-runtime.ts`.
