---
title: WeChat Integration
nav_title: WeChat
description: Scan a QR code in Settings to log in a WeChat bot account, then authorize individual users with a pairing code.
order: 3
---

# WeChat Integration

For people who only want to use WeChat: the whole setup is one QR scan, with no developer platform to register on. The trade-off is that permission approval is text replies rather than tappable buttons, and only private chats are supported.

Besides text, this path also accepts transcribed voice content, images, and file attachments.

## Bind the bot account

1. Open **Settings → IM Adapters** and select the **WeChat** tab.
2. Select **Scan to Bind**.
3. Scan the QR code with WeChat and confirm the login on your phone.
4. Wait for the status to read **WeChat is bound**.

Credentials are written to local configuration and the adapter restarts on its own; no separate save is needed. The tab then offers **Rescan** and **Unbind WeChat account**.

Binding the bot account is not the same as allowing every WeChat contact. Who may use it is decided in the next step.

## Authorize a user

1. Back at the top of the page, under **Pairing**, select **Generate Code**.
2. Send the six-character code to the bound bot in WeChat.
3. Once pairing is confirmed, you can send messages directly.

Codes are valid for 60 minutes, work once, and are invalidated when a new one is generated.

Known WeChat user IDs can instead be entered in **Allowed Users**, separated by commas. That suits a fixed allowlist but is less convenient than pairing.

## Projects and sessions

With **Default Project** set, the first accepted message opens a session in that directory. Without it, the bot lists recent projects; reply with a number, project name, or absolute path.

Later messages in the same chat reuse that session, and the mapping survives a Desktop restart. `/new` picks another project; `/clear` empties the context while keeping the project binding.

## Commands

WeChat has no configurable menu, so the chat box is the only entry point. After pairing, the bot suggests `/help`.

- `/help` or `帮助` — show available commands
- `/status` or `状态` — project, branch, model, run state, and task summary
- `/projects` or `项目列表` — list recent projects again
- `/new` or `新会话` — clear the current binding and choose a project
- `/new <number, project name, or absolute path>` — start directly in that project
- `/clear` or `清空` — clear context, keep the project binding
- `/stop` or `停止` — stop the current generation

## Approval and reply behavior

A permission request arrives as text containing a request ID. Reply with one of:

- `/allow <requestId>` — allow once
- `/always <requestId>` — persist the matching approval
- `/deny <requestId>` — deny

Messages are received through long polling and long replies are split into platform-sized messages. A typing indicator is shown while Claude thinks or runs tools. Images enter model input inline; other files are downloaded to a local temporary path. Oversized attachments are reported back in the chat.

## Unbind

Two levels:

- **Unbind WeChat account** clears the bot credentials and this platform's authorization lists. Binding again means scanning again.
- **Unbind** next to a name under **Paired Users** revokes only that person. They need a fresh pairing code afterwards.

## Development

Packaged Desktop starts the sidecar automatically. Run it by hand only when working from source:

```bash
cd adapters
bun install
bun run wechat
```

Optional overrides:

```bash
export WECHAT_ACCOUNT_ID="..."
export WECHAT_BOT_TOKEN="..."
export WECHAT_BASE_URL="https://ilinkai.weixin.qq.com"
export WECHAT_USER_ID="..."
export ADAPTER_SERVER_URL="ws://127.0.0.1:3456"
```

Normal Desktop use needs none of these; QR binding writes the local configuration.

## Troubleshooting

**Still unauthorized after a successful scan.** That is the expected flow. Scanning only stores bot credentials; the individual user still has to send a pairing code or appear in **Allowed Users**.

**The QR code expired.** Select **Scan to Bind** again. WeChat login QR codes are short-lived.

**The adapter reports a missing WeChat account.** Neither the environment variables nor `wechat.accountId` / `wechat.botToken` in `~/.claude/adapters.json` took effect. Complete QR binding in Settings first.

**No replies.** Confirm Desktop is running, the tab reads **WeChat is bound**, the sender is paired or allowlisted, and `~/.claude/adapters.json` is writable. When running from source, also confirm `ADAPTER_SERVER_URL` points at the running Desktop server.

**Session not restored after a restart.** Verify that `~/.claude/adapter-sessions.json` is writable and that the session still exists in Desktop.

## Source

`index.ts`, `protocol.ts`, and `media.ts` under `adapters/wechat/`, plus `pairing.ts`, `session-store.ts`, `ws-bridge.ts`, and `http-client.ts` under `adapters/common/`.
