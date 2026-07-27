---
title: Feishu Integration
nav_title: Feishu
description: Create a Feishu bot from the official template and drive Desktop sessions from a private chat with card-based approval.
order: 1
---

# Feishu Integration

Best for teams already on Feishu: an official template creates a bot with every required permission preconfigured, and permission requests arrive as interactive cards you can tap. Common commands can be exposed as a bot menu. It handles private (`p2p`) chats only, and changing the bot configuration means publishing a new version in the developer console.

## Create the bot

Open [Create a Feishu bot](https://open.feishu.cn/page/openclaw?form=multiAgent). This is the official OpenClaw template, with messaging, event subscription, and card callback permissions already granted — no scopes to add by hand. The **Create Feishu bot** button under **Settings → IM Adapters → Feishu** opens the same page.

Choose a name, create the app, then keep its **App ID** and **App Secret** for the next step.

## Configure the bot menu

This step is optional. With a menu, you can switch projects and start sessions by tapping instead of typing.

In the [Feishu developer console](https://open.feishu.cn/app?lang=en-US), open your bot and go to its bot menu configuration. Add three entries, each with a label of your choice and one of these commands:

- `/projects` — list recent projects and switch
- `/new` — start a new session
- `/clear` — clear the current context

Save the menu, then publish a new application version. Menu changes take effect only after publishing.

## Enter credentials in Desktop

1. Open **Settings → IM Adapters** and select the **Feishu** tab.
2. Paste the values into **App ID** and **App Secret**.
3. Leave **Encrypt Key** and **Verification Token** empty; the template bot does not need them.
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

**No messages arrive.** Confirm the app is published — menu edits require a new version — and that the conversation is a private chat rather than a group.

**Card buttons do nothing.** The card action capability usually did not ship with the published version. Publish again from the developer console.

**Still unauthorized.** Check that the code is within its 60-minute window, that it is the current one, and that the account now appears under **Paired Users** in Desktop.

**Session not restored after a restart.** Verify that `~/.claude/adapter-sessions.json` is writable and that the session still exists in Desktop.

## Source

`adapters/feishu/index.ts`, plus `pairing.ts`, `session-store.ts`, `ws-bridge.ts`, and `http-client.ts` under `adapters/common/`.
