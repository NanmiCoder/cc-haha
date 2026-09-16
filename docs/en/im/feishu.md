---
title: Feishu Integration
nav_title: Feishu
description: Scan a QR code in Settings to create a Feishu bot, then drive Desktop sessions from a private chat with card-based approval.
order: 1
---

# Feishu Integration

Best for teams already on Feishu: select **Scan to Create** in Settings, scan with Feishu, and the bot is created with its App ID and App Secret stored locally. Permission requests arrive as interactive cards you can tap, and common commands can be exposed as a bot menu. It handles private (`p2p`) chats only, and changing the bot menu means publishing a new version in the developer console.

## Create the bot by scanning

1. Open **Settings → IM Adapters** and select the **Feishu** tab.
2. Select **Scan to Create**. A QR code appears.
3. Scan it with Feishu. The confirmation page arrives pre-filled with the bot's name, description, and exactly the scopes, event subscriptions, and card callback this adapter calls — nothing extra is requested.
4. On confirmation the App ID and App Secret are written to `~/.claude/adapters.json` and the adapter restarts.

The code is valid for 10 minutes; generate a new one if it lapses. Once bound, the button becomes **Scan Again** and an **Unbind Feishu bot** button appears next to it.

Scanning only ever **creates** a new bot; it never binds an existing one, which would let this flow quietly rewrite the callback configuration of a bot you already run.

Leave **Encrypt Key** and **Verification Token** empty: messages travel over the WebSocket connection, which does not use them.

::: tip Creating one by hand also works
If you would rather not scan, or want to reuse an existing bot, create one from the [official OpenClaw template](https://open.feishu.cn/page/openclaw?form=multiAgent) and paste its App ID and App Secret into the fields below the QR panel. Desktop also shows that entry point while no credentials are stored.
:::

## Configure the bot menu

This step is optional. With a menu, you can switch projects and start sessions by tapping instead of typing.

In the [Feishu developer console](https://open.feishu.cn/app?lang=en-US), open your bot and go to its bot menu configuration. Add three entries, each with a label of your choice and one of these commands:

- `/projects` — list recent projects and switch
- `/new` — start a new session
- `/clear` — clear the current context

Save the menu, then publish a new application version. Menu changes take effect only after publishing.

## Entering credentials by hand

A bot created by scanning needs none of this — its credentials are already stored. This is only for the template flow or for reusing an existing bot:

1. Open **Settings → IM Adapters** and select the **Feishu** tab.
2. Paste the values into **App ID** and **App Secret**.
3. Leave **Encrypt Key** and **Verification Token** empty; the long-connection mode does not need them.
4. Enable **Streaming Card Mode** if you want long replies to update one card in place.
5. Select **Save**.

**Allowed Users** can stay empty. When it is, only paired accounts are accepted, which is usually what you want.

## Pair your account

At the top of the page, under **Pairing**, select **Generate Code**. The six-character code is written to local configuration immediately — no separate save.

Send any message to your new bot in Feishu, then send the code when prompted. Once pairing is confirmed you can talk to Claude Code directly.

Codes are valid for 60 minutes, work once, and are invalidated when a new one is generated.

## Commands

Alongside the menu buttons, these work in the chat box at any time:

- `/help` or `帮助`
- `/status` or `状态`
- `/projects` or `项目列表`
- `/new` or `新会话`
- `/clear` or `清空`
- `/stop` or `停止`

## Approval and reply behavior

Permission requests arrive as interactive cards. Selecting allow or deny returns the result to the pending Desktop session.

Normal replies use Feishu post messages. Streaming output prefers patching the same message, and long completed text is split to respect platform limits.

## Development

Packaged Desktop starts the sidecar automatically. Run it by hand only when working from source:

```bash
cd adapters
bun install
bun run feishu
```

Optional overrides:

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
export ADAPTER_SERVER_URL="ws://127.0.0.1:3456"
```

## Troubleshooting

**Scanning does nothing.** The flow runs on `accounts.feishu.cn`; confirm your machine can reach it. International (Lark) tenants switch to `accounts.larksuite.com` automatically after confirmation — there is nothing to change by hand.

**The code reports as expired.** It is valid for 10 minutes; select **Scan Again** for a new one.

**No messages arrive.** Confirm the app is published — menu edits require a new version — and that the conversation is a private chat rather than a group.

**Card buttons do nothing.** The card action capability usually did not ship with the published version. Publish again from the developer console.

**Still unauthorized.** Check that the code is within its 60-minute window, that it is the current one, and that the account now appears under **Paired Users** in Desktop.

**Session not restored after a restart.** Verify that `~/.claude/adapter-sessions.json` is writable and that the session still exists in Desktop.

## Source

`adapters/feishu/index.ts` (runtime) and `adapters/feishu/registration.ts` (scan to create), plus `pairing.ts`, `session-store.ts`, `ws-bridge.ts`, and `http-client.ts` under `adapters/common/`.
