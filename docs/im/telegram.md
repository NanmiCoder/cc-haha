---
title: Telegram Integration
nav_title: Telegram
description: Get a Bot Token from BotFather, paste it into Desktop, and approve permissions with native buttons.
order: 2
---

# Telegram Integration

The fastest of the five to set up: ask `@BotFather` for a token, paste it into Desktop, done. Permission requests come back as native buttons. It accepts private chats only; groups are not supported.

## Create a bot

In Telegram, open the official `@BotFather` account and send `/newbot`. Then:

1. Choose a display name, for example `cc-haha Bot`.
2. Choose a username in Latin letters ending in `_bot`, for example `jiang_cc_hah_bot`.
3. Copy the **Bot Token** that BotFather returns.

That token is the bot's password. Do not paste it anywhere public.

## Enter the token in Desktop

1. Open **Settings → IM Adapters** and select the **Telegram** tab.
2. Paste the value into **Bot Token**.
3. Select **Save**.

**Allowed Users** can stay empty. When it is, only paired accounts are accepted. To allowlist a known account directly, enter its numeric Telegram user ID; separate several with commas.

## Pair your account

At the top of the page, under **Pairing**, select **Generate Code**. The six-character code takes effect immediately — no separate save.

Send any message to your new bot, then send the code when prompted. Once pairing is confirmed you can talk to Claude Code directly.

Codes are valid for 60 minutes, work once, and are invalidated when a new one is generated. Repeated failures are rate limited; wait a few minutes before retrying.

## Commands

- `/start` — show help and available commands
- `/help` — show available commands
- `/projects` — list recent projects and switch
- `/resume` — choose and restore a previous session
- `/status` — project, model, run state, and task summary
- `/new` — clear the current binding and choose a project again
- `/clear` — clear context, keep the project binding
- `/stop` — stop the current generation
- `/provider` — view or switch the provider
- `/model [model]` — view or switch the model
- `/skills` — list project Skills and invoke one by selecting it

## Agent capabilities and boundaries

Telegram is not a separate question-and-answer model. Regular messages and Skills selected from `/skills` enter the same Claude Code Agent session for the current project, so they retain multi-turn context and can use the file, terminal, Git, Skill, and MCP tools already available to that session. Selecting a Skill sends its `/<skill-name>` invocation into the Agent, where the existing Skill system loads `SKILL.md` and continues the task.

These capabilities are intended for one trusted user remotely controlling their own machine. A paired account receives the full Agent capabilities available in the selected project. Permission prompts are an operation gate, not an operating-system sandbox. Do not expose the Bot to public groups or untrusted accounts, and do not install unreviewed Skills, Plugins, or MCP servers from chat.

The adapter accepts private chats only from paired or allowlisted accounts. Project lists, name matching, and historical session restore are restricted to the configured project root. New remote sessions always use the `default` permission mode, and historical `bypassPermissions` sessions are not restored remotely. Local images in Agent output must resolve inside the active session work directory; the Adapter never fetches remote image URLs from Agent-authored text.

## Approval and reply behavior

A permission request arrives as a message with three buttons: allow once, always allow the matching operation for this session, and deny. Only a currently pending request can be confirmed, and the choice is converted to a `permission_response` for that same Desktop session.

Replies pass through a streaming buffer: a placeholder can be sent while Claude is thinking, text deltas accumulate in place, and completed text is split into platform-sized messages.

## Development

Packaged Desktop starts the sidecar automatically. Run it by hand only when working from source:

```bash
cd adapters
bun install
bun run telegram
```

Optional overrides:

```bash
export TELEGRAM_BOT_TOKEN="123456:ABC-DEF..."
export ADAPTER_SERVER_URL="ws://127.0.0.1:3456"
```

## Troubleshooting

**The adapter reports a missing token.** Neither `TELEGRAM_BOT_TOKEN` nor `telegram.botToken` in `~/.claude/adapters.json` took effect. Re-enter the token in Settings and save.

**Settings opens but the bot does nothing.** When running from source, the web app only writes configuration; it does not launch `bun run telegram`. Packaged Desktop starts the sidecar for you.

**A sender is rejected.** Confirm a code was generated, that it is within its 60-minute window, and that it was sent to the correct bot in a private chat.

**Session not restored after a restart.** Verify that `~/.claude/adapter-sessions.json` is writable and that the session still exists in Desktop.

## Source

`adapters/telegram/index.ts`, plus `pairing.ts`, `session-store.ts`, `ws-bridge.ts`, `message-buffer.ts`, and `format.ts` under `adapters/common/`.
