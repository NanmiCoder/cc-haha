# DingTalk Integration

The DingTalk adapter uses DingTalk Stream, so it does not require a public callback URL. It supports private chats only.

Current behavior includes text, image attachments, project selection, status, stop, AI Card streaming, and text or card-based permission approval.

## Bind a DingTalk bot

Open **Settings → IM Integration → DingTalk**.

The recommended flow is:

1. Select **Scan to bind**.
2. Scan with the DingTalk mobile app.
3. Confirm bot creation and authorization.
4. Wait for Desktop to show the bound state.
5. Save the configuration.

Desktop stores `clientId` and `clientSecret` in `~/.claude/adapters.json` and restarts the adapter sidecar.

## Manual credentials

If QR binding is unavailable, enter:

- **Client ID** — DingTalk application `appKey`
- **Client Secret** — application `appSecret`
- **Stream Endpoint** — optional; defaults to `https://api.dingtalk.com`
- **Permission card template ID** — optional
- **Allowed Users** — optional explicit user IDs

Saving starts a DingTalk Stream connection.

## Authorize a user

Binding the bot does not authorize every DingTalk account. Generate a six-character pairing code in Desktop and send it to the bot in a private chat.

Codes expire after 60 minutes, are one-time use, and are rate limited after repeated failures. Paired users can be removed from Desktop at any time.

## Projects and commands

If no default project is configured, the adapter returns recent projects. Reply with a number, project name, or absolute path. The mapping is persisted in `~/.claude/adapter-sessions.json`.

Supported commands:

- `/help` or `帮助`
- `/status` or `状态`
- `/projects` or `项目列表`
- `/new` or `新会话`
- `/new <number, project name, or absolute path>`
- `/clear` or `清空`
- `/stop` or `停止`

## Permission approval

Without a published card template, reply:

- `/allow <requestId>`
- `/always <requestId>`
- `/deny <requestId>`

With a configured permission-card template, the adapter prefers an interactive card and receives its callback over DingTalk Stream. Text commands remain the fallback.

## Replies and attachments

- Private messages arrive through `dingtalk-stream`.
- Normal replies use the message `sessionWebhook`.
- AI Card is preferred for streaming output.
- Image attachments are downloaded and passed as inline image input.
- Shared attachment size limits are enforced.

## Unbind

Unbinding the bot clears DingTalk credentials, allowlisted and paired users, and the permission-card template ID. Removing a single paired user revokes only that user.

## Development

Packaged Desktop starts the sidecar automatically. For source development:

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
