---
title: WeCom Integration
nav_title: WeCom
description: Scan a QR code in Settings to create an Enterprise WeChat AI bot, then drive the Desktop app from a private chat with streaming replies.
order: 6
---

# WeCom Integration

For teams already on Enterprise WeChat. Select **Scan to Bind** in Settings, scan with the WeCom app, and the AI bot is created for you — its Bot ID and Secret land in local configuration without opening the admin console. Messages travel over the official WebSocket connection, so your machine needs no public address.

Limits: private chats only, no group chats; permission approval is a text reply, not a card.

## Create the bot by scanning

1. Open **Settings → IM Adapters** and switch to the **WeCom** tab.
2. Select **Scan to Bind**. A QR code appears.
3. Scan it with Enterprise WeChat and confirm creating the AI bot.
4. On success the Bot ID and Secret are written to `~/.claude/adapters.json` and the adapter restarts.

The code expires after five minutes; **Scan Again** issues a new one. Once bound, the button becomes **Scan Again** and an **Unbind bot account** button appears next to it.

This step only gives the Desktop app the bot's credentials. It does **not** authorize your colleagues — that is what pairing below decides.

## Pairing

Back at the top of the page, under **Pairing**, select **Generate Code** to get a six-character code. This takes effect immediately; no **Save** is needed.

Send that code to the new bot in a private WeCom chat. Once pairing is confirmed, anything you type goes to Claude Code.

A code is valid for 60 minutes, works once, and is invalidated the moment a new one is generated. Five failed attempts within five minutes trigger rate limiting.

**Allowed Users** can stay empty, in which case only paired accounts can use the bot. To allow known colleagues directly, enter their WeCom `userid` values separated by commas and select **Save**.

## Supported commands

- `/help` or `帮助` — list the available commands
- `/status` or `状态` — current project, model, and run state
- `/projects` or `项目列表` — list recent projects and switch
- `/new` or `新会话` — start a fresh session, optionally with an index, name, or absolute path
- `/clear` or `清空` — clear the context, keep the project binding
- `/stop` or `停止` — stop the current turn
- Permission approval: reply `1` to allow once, `2` to allow for the session, `3` to deny; `/allow <id>`, `/always <id>`, and `/deny <id>` work too

## How messages look

Replies use WeCom stream messages: one bubble refreshes in place as the answer is generated, then settles. A single stream message caps at 20 KB, so anything beyond that continues as follow-up messages rather than being truncated.

Inbound images and files are decrypted into `~/.claude/im-downloads/wecom/` and forwarded to the Agent as attachments. Voice notes arrive already transcribed by WeCom and are handled as plain text. Local images referenced in the Agent's output (restricted to the current session's working directory) are uploaded and sent as separate image messages.

## Agent capability and boundaries

WeCom is not a separate question-and-answer model. Messages enter the same Claude Code Agent session as the current project, so they continue the multi-turn context and can use the files, terminal, Git, Skills, and MCP tools that session already has.

That means a paired account holds the full Agent capability of the current project. Permission confirmation is a gate on individual operations, not an OS sandbox. Do not hand the bot to people you do not trust, and do not install unreviewed Skills, plugins, or MCP servers from chat.

The adapter accepts only paired or allow-listed private chats, and project listing and name matching stay inside **Allowed project directories**.

## Running it locally

Release builds start the adapter as a sidecar automatically. Manual startup is only needed when running from source:

```bash
cd adapters
bun install
bun run wecom
```

Optional environment overrides:

```bash
export WECOM_BOT_ID="xxx"
export WECOM_BOT_SECRET="xxx"
export ADAPTER_SERVER_URL="ws://127.0.0.1:3456"
```

## Troubleshooting

**No QR code appears.** The scan endpoint lives on `work.weixin.qq.com`; confirm your machine can reach it, and that a proxy is not blocking that host.

**Scanned successfully but the bot stays silent.** Confirm the Desktop app is still running and that the **WeCom** tab shows a Bot ID. Credentials are written the moment the scan succeeds, and the adapter restarts on its own.

**Messages report "unauthorized".** Check that a pairing code was generated, that it is still inside its 60-minute window, and that you sent the current one.

**Mentioning the bot in a group does nothing.** That is intended: only private chats are handled. Pairing authorizes one person, and answering in a group would extend that authorization to everyone in it.

## Source entry points

`adapters/wecom/index.ts` (runtime), `adapters/wecom/qr-auth.ts` (scan to create), `adapters/wecom/extract-payload.ts` (inbound parsing), plus the shared session loop in `adapters/common/chat-runtime.ts`.
