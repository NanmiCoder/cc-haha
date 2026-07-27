---
title: DingTalk Integration
nav_title: DingTalk
description: Authorize a DingTalk bot by QR code and run over DingTalk Stream, with no public callback URL required.
order: 4
---

# DingTalk Integration

For organizations already running on DingTalk: one QR scan authorizes a bot, and the adapter connects over DingTalk Stream, so no public callback URL or tunnel is needed. Replies stream through an AI Card by default. Only private chats are supported, and tappable approval cards need one extra template ID — otherwise approval is text replies.

## Bind the bot by QR code

1. Open **Settings → IM Adapters** and select the **DingTalk** tab.
2. Under **Bind DingTalk bot with QR**, select **Scan to bind**.
3. Scan with the DingTalk mobile app and confirm bot creation and authorization.
4. Wait for Desktop to report the bound state.

**Client ID** and **Client Secret** are filled in and written to local configuration automatically, and the adapter reconnects with them.

## Manual credentials

If QR binding is unavailable, fill in the fields below the QR area yourself:

- **Client ID** — the DingTalk application `appKey`
- **Client Secret** — the application `appSecret`
- **Stream Endpoint** — optional; defaults to `https://api.dingtalk.com`
- **Permission Card Template ID** — optional; when set, permission requests prefer an interactive card
- **Allowed Users** — optional; explicit DingTalk user IDs

Select **Save**, and the adapter opens a DingTalk Stream connection with the new credentials.

## Authorize a user

Binding the bot does not authorize every DingTalk account.

1. Back at the top of the page, under **Pairing**, select **Generate Code**.
2. Send the six-character code to the bot in a private chat.
3. Once pairing is confirmed, you can start chatting.

Codes are valid for 60 minutes and work once. Paired accounts appear under **Paired Users** and can be revoked at any time; a revoked user needs a fresh code.

## Projects and sessions

With **Default Project** set, the first accepted message opens a session in that directory. Without it, the bot lists recent projects; reply with a number, project name, or absolute path.

Later messages in the same chat reuse that session. `/new` picks another project; `/clear` empties the context while keeping the project binding.

## Commands

DingTalk has no bot menu like Feishu, so the chat box is the only entry point. After pairing, the bot suggests `/help`.

- `/help` or `帮助` — show available commands
- `/status` or `状态` — project, branch, model, run state, and task summary
- `/projects` or `项目列表` — list recent projects again
- `/new` or `新会话` — clear the current binding and choose a project
- `/new <number, project name, or absolute path>` — start directly in that project
- `/clear` or `清空` — clear context, keep the project binding
- `/stop` or `停止` — stop the current generation

## Approval and reply behavior

By default a permission request arrives as text. Reply with one of:

- `/allow <requestId>` — allow once
- `/always <requestId>` — persist the matching approval
- `/deny <requestId>` — deny

With a published template entered in **Permission Card Template ID**, the adapter prefers an interactive card and receives the button callback over DingTalk Stream. Text commands stay available whenever a card fails to send or cannot be seen.

Normal replies prefer AI Card streaming. Image attachments are downloaded and passed as inline image input; oversized attachments are reported back in the chat.

## Unbind

Two levels:

- **Unbind bot account** clears the DingTalk credentials, the permission card template ID, and this platform's authorization lists. Binding again means scanning or entering credentials again.
- **Unbind** next to a name under **Paired Users** revokes only that person.

## Development

Packaged Desktop starts the sidecar automatically. Run it by hand only when working from source:

```bash
cd adapters
bun install
bun run dingtalk
```

Optional overrides:

```bash
export DINGTALK_CLIENT_ID="..."
export DINGTALK_CLIENT_SECRET="..."
export DINGTALK_STREAM_ENDPOINT="https://api.dingtalk.com"
export DINGTALK_PERMISSION_CARD_TEMPLATE_ID="..."
export ADAPTER_SERVER_URL="ws://127.0.0.1:3456"
```

Normal Desktop use needs none of these; QR binding or manual entry writes the local configuration.

## Troubleshooting

**Still unauthorized after a successful scan.** That is the expected flow. Scanning only stores bot credentials; the individual user still has to send a pairing code or appear in **Allowed Users**.

**Scanning fails or waits forever.** Select **Scan to bind** again for a fresh QR code. If it still fails, enter **Client ID** and **Client Secret** manually.

**The adapter reports missing credentials.** Neither the environment variables nor `dingtalk.clientId` / `dingtalk.clientSecret` in `~/.claude/adapters.json` took effect. Complete QR binding or manual entry in Settings first.

**No permission card appears.** Confirm the template ID belongs to a published template, that the template supports the callback route the adapter uses, and that the bot has published a new version. Text approval works regardless.

**No replies.** Confirm Desktop is running, the tab shows the bound state, the sender is paired or allowlisted, and `~/.claude/adapters.json` is writable. When running from source, also confirm `ADAPTER_SERVER_URL` points at the running Desktop server.

## Source

`index.ts`, `helpers.ts`, `ai-card.ts`, `permission-card.ts`, and `media.ts` under `adapters/dingtalk/`, plus `pairing.ts`, `session-store.ts`, `ws-bridge.ts`, and `http-client.ts` under `adapters/common/`.
