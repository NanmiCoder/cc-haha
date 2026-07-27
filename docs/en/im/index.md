---
title: IM Integrations
nav_title: Overview
description: Bridge Feishu, Telegram, WeChat, DingTalk, or WhatsApp private chats into the Desktop app and continue the same session from your phone.
order: 0
---

# IM Integrations

A session running in the Desktop app can be reached from a private chat on your phone. Once bound, a message in Feishu, Telegram, WeChat, DingTalk, or WhatsApp drives the Claude Code session on your own machine: start a long task before you leave, then follow the progress, approve permissions, and switch projects from the road.

The chat partner is a bot or account you bound yourself. Messages reach your local Desktop app; no intermediate service holds your code.

![Settings shows pairing management on top and one tab per platform](../../images/app/settings-im.webp)

## What you get

- **The same session, continued.** Messages sent from your phone enter the Claude Code session on your computer, where file edits, commands, and reads really happen.
- **Project switching.** `/projects` lists recent projects and switches to the one you pick; `/new` starts a fresh session.
- **Permission approval.** When Claude wants to write a file or run a risky command, the request is pushed to the chat. Feishu and DingTalk send interactive cards, Telegram sends buttons, WeChat and WhatsApp expect a text reply.
- **Status and stop.** `/status` reports the current project, model, and run state; `/stop` interrupts the current turn.

The Desktop app has to stay running. The chat side is only a remote control.

## Choosing a platform

All five expose the same capabilities. They differ in setup cost and approval experience.

| Platform | How you connect | Best for | Known limits |
|---|---|---|---|
| Feishu | Create a bot from the official template, paste its App ID and App Secret | Teams that want one-tap permission approval | Private (`p2p`) chats only; menu changes require publishing a new app version |
| Telegram | Ask `@BotFather` for a Bot Token, paste it into Settings | Individuals who can reach Telegram; fastest setup | Private chats only |
| WeChat | Scan a QR code in Settings to log in a bot account | People who only want WeChat | Private chats only; permission approval is text replies |
| DingTalk | Scan a QR code in Settings; credentials are filled in for you | Organizations already on DingTalk | Private chats only; interactive approval cards need an extra template ID |
| WhatsApp | Scan from **Linked devices** on your phone | Users outside mainland China | Personal linked-device login, not the official Cloud API; personal private chats only |

If you have no preference, start with Telegram or Feishu — their approval flows are the most comfortable.

## Pairing flow

Binding happens in two layers: first the Desktop app gets platform credentials, then your personal account is authorized with a pairing code. The second layer is identical everywhere.

1. Open **Settings → IM Adapters**.
2. Bind one platform in its tab: Feishu and Telegram take credentials, WeChat, DingTalk, and WhatsApp use a QR code.
3. Pick a directory under **Default Project**.
4. Select **Save**.
5. Back at the top, in **Pairing**, select **Generate Code** to get a six-character code.
6. Send that code to your bot in a private chat on the matching platform.
7. Once pairing is confirmed, anything you type goes to Claude Code.

A code is valid for 60 minutes, works once, and is invalidated the moment a new one is generated. The code itself is platform-neutral — it binds whichever account sends it. Five failed attempts within five minutes trigger rate limiting.

Generating a code and QR binding are written to local configuration immediately. **Save** is only needed for typed values such as App ID, Bot Token, **Allowed Users**, and **Default Project**.

Paired accounts appear under **Paired Users**, where **Unbind** revokes one of them. A revoked user needs a fresh code.

## Default project decides where work happens

**Default Project** is the working directory for new IM sessions. With it set, the first message from your phone opens a session in that directory. Left empty, the bot lists recent projects and asks you to choose.

Later messages in the same chat reuse that session, and the mapping survives a Desktop restart. `/new` changes the directory; `/clear` empties the context while keeping the project binding.

## Common commands

Entry points differ slightly per platform — Feishu can expose commands as a bot menu — but these work everywhere:

- `/help` — list available commands
- `/status` — current project, model, and run state
- `/projects` — list recent projects and switch
- `/new` — start a new session, optionally with a project number or path
- `/clear` — clear context, keep the project binding
- `/stop` — stop the current generation

WeChat, DingTalk, and Feishu also accept Chinese aliases such as `帮助`, `状态`, `项目列表`, `新会话`, `清空`, and `停止`.

## Security

::: warning This is a remote control for your computer
A paired account can make Claude read files, write files, and run commands on your machine. Send pairing codes only to yourself, never post one in a group, and never commit bot credentials.
:::

Authorization is the union of **Allowed Users** and paired users. When both are empty, every sender is rejected. Binding a bot or a linked account does not authorize its contacts.

Platform credentials, pairing state, and allowlists live in `~/.claude/adapters.json`; chat-to-session mappings live in `~/.claude/adapter-sessions.json`. Both stay on your machine, both contain material that can drive it, and neither should be shared. Sensitive fields are masked when the settings page reads the configuration back. Both paths follow `CLAUDE_CONFIG_DIR` when a custom data directory is active.

For a full mobile interface rather than a chat window, see [H5 access](../desktop/remote.md).

## Per-platform guides

- [Feishu](./feishu.md) — template bot, card approval
- [Telegram](./telegram.md) — BotFather token, button approval
- [WeChat](./wechat.md) — QR-bound account, text approval
- [DingTalk](./dingtalk.md) — QR authorization, AI Card streaming
- [WhatsApp](./whatsapp.md) — personal linked device, text approval
