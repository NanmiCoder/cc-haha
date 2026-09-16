---
title: Slack Integration
nav_title: Slack
description: Create a Slack app from a pre-filled manifest and drive the Desktop app from direct messages over Socket Mode.
order: 8
---

# Slack Integration

For teams already on Slack. Slack has no QR flow; the closest equivalent is an **app manifest**. The Desktop app pre-fills the scopes, event subscriptions, and Socket Mode setting — you open the link, confirm, and paste two tokens back.

Socket Mode is used for the same reason Feishu, WeCom, and QQ use long connections: your machine needs no public address, and Slack never calls back into your computer.

Limits: direct messages only, no channels; permission approval is a text reply.

## Create the Slack app

1. Open **Settings → IM Adapters** and switch to the **Slack** tab.
2. Select **Create app from manifest**. Slack's create page opens with the manifest pre-filled; **Show the app manifest JSON** on the settings page reveals the same content if you would rather paste it by hand.
3. Pick a workspace, review the manifest, and create the app.
4. Under **Install App**, install it into the workspace and copy the **Bot User OAuth Token** (starts with `xoxb-`).
5. Under **Basic Information → App-Level Tokens**, generate a token with the `connections:write` scope (starts with `xapp-`).
6. Paste both into **Bot Token** and **App-Level Token** in Settings, then select **Save**.

The manifest requests exactly the scopes the adapter calls — nothing speculative:

| Scope | What it is for |
|---|---|
| `chat:write` | Post messages and update one in place |
| `im:history` | Receive `message.im` direct-message events |
| `files:read` | Download attachments you send |
| `files:write` | Send images the Agent produces back to you |
| `users:read` | Show a display name instead of a raw ID under **Paired Users** |

## Pairing

Back at the top of the page, under **Pairing**, select **Generate Code** to get a six-character code. This takes effect immediately; no **Save** is needed.

Send that code to the app as a direct message. Once pairing is confirmed, anything you type goes to Claude Code.

A code is valid for 60 minutes, works once, and is invalidated the moment a new one is generated. Five failed attempts within five minutes trigger rate limiting.

**Allowed Users** can stay empty, in which case only paired accounts can use the bot. To allow known colleagues directly, enter their Slack user IDs (starting with `U`) separated by commas.

## Supported commands

- `/help` or `帮助` — list the available commands
- `/status` or `状态` — current project, model, and run state
- `/projects` or `项目列表` — list recent projects and switch
- `/new` or `新会话` — start a fresh session, optionally with an index, name, or absolute path
- `/clear` or `清空` — clear the context, keep the project binding
- `/stop` or `停止` — stop the current turn
- Permission approval: reply `1` to allow once, `2` to allow for the session, `3` to deny; `/allow <id>`, `/always <id>`, and `/deny <id>` work too

These are ordinary message text, not Slack slash commands. The manifest requests no slash commands, so nothing here collides with what your workspace already defines.

## How messages look

A reply posts one message and then edits it in place, throttled to roughly one edit per second so it does not run into Slack's `chat.update` rate limit. When the answer outgrows a single message, the earlier part is sealed and the remainder continues in a new message that keeps updating.

Attachments you send are downloaded with the bot token from `files.slack.com` (only that host is accepted). Images go straight to the Agent; other files are staged in `~/.claude/im-downloads/slack/`. Local images referenced in the Agent's output (restricted to the current session's working directory) are sent back through Slack's external upload flow.

## Agent capability and boundaries

Slack is not a separate question-and-answer model. Messages enter the same Claude Code Agent session as the current project, so they continue the multi-turn context and can use the files, terminal, Git, Skills, and MCP tools that session already has.

That means a paired account holds the full Agent capability of the current project. Permission confirmation is a gate on individual operations, not an OS sandbox. Do not install the app into a workspace you do not trust, and do not install unreviewed Skills, plugins, or MCP servers from chat.

The adapter accepts only paired or allow-listed direct messages. Channel messages, edits, deletions, and the bot's own messages are discarded.

## Running it locally

Release builds start the adapter as a sidecar automatically. Manual startup is only needed when running from source:

```bash
cd adapters
bun install
bun run slack
```

Optional environment overrides:

```bash
export SLACK_BOT_TOKEN="xoxb-..."
export SLACK_APP_TOKEN="xapp-..."
export ADAPTER_SERVER_URL="ws://127.0.0.1:3456"
```

## Troubleshooting

**The adapter exits with `invalid_auth`.** The bot token is wrong or the app is not installed into the workspace. Copy it again from **Install App**.

**Socket Mode reconnects in a loop.** The app-level token is missing the `connections:write` scope, or it has been revoked. Generate a new one.

**Direct messages get no response.** Confirm the `message.im` event subscription is still present and that the Messages Tab is enabled under **App Home**. If you edited the app configuration by hand, check it against the scope table above.

**Attachments never arrive.** `files:read` is missing; that scope only takes effect after reinstalling the app.

**Messages report "unauthorized".** Check that a pairing code was generated, that it is still inside its 60-minute window, and that you sent the current one.

## Source entry points

`adapters/slack/index.ts` (runtime), `adapters/slack/api.ts` (Web API wrapper), `adapters/slack/socket-mode.ts` (long connection), `adapters/slack/manifest.ts` (app manifest), `adapters/slack/extract-payload.ts` (inbound filtering), plus the shared session loop in `adapters/common/chat-runtime.ts`.
