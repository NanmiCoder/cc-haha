# WeChat Integration

The WeChat adapter binds a bot account by QR code, then authorizes individual private-chat users through pairing or an allowlist.

It supports text, transcribed voice content, image and file attachments, project selection, status, stop, and text-based permission approval. Group chats are not supported.

## Bind the WeChat bot account

Open **Settings → IM Integration → WeChat**:

1. Select **Scan to bind**.
2. Scan the QR code with WeChat.
3. Confirm the login in WeChat.
4. Wait for Desktop to show the bound state.
5. Save the configuration.

Desktop stores the returned `accountId`, `botToken`, `baseUrl`, and `userId` in the `wechat` section of `~/.claude/adapters.json`, then restarts the adapter sidecar.

Binding credentials does not authorize every WeChat user.

## Authorize a user

Generate a pairing code at the top of **IM Integration**, then send the six-character code to the bound bot in a private chat.

The code:

- expires after 60 minutes;
- can be used once;
- is replaced immediately when a new code is generated;
- is rate limited after repeated failures.

Known WeChat user IDs can instead be entered in `Allowed Users`.

## Projects and sessions

With a default project configured, the first accepted message creates or resumes a session in that directory.

Without a default project, the adapter returns recent projects. Reply with a number, project name, or absolute path. The resulting chat-to-session mapping is stored in `~/.claude/adapter-sessions.json`.

Use `/new` to choose another project and start a new session.

## Commands

- `/help` or `帮助`
- `/status` or `状态`
- `/projects` or `项目列表`
- `/new` or `新会话`
- `/new <number, project name, or absolute path>`
- `/clear` or `清空`
- `/stop` or `停止`

## Permission approval

Reply to the text approval message with:

- `/allow <requestId>` — allow once
- `/always <requestId>` — persist the matching approval
- `/deny <requestId>` — deny

The adapter sends the response back to the pending Desktop session.

## Attachments and replies

- WeChat messages are received through long polling.
- Long text is split into platform-sized messages.
- Images enter model input as inline images.
- Other files are downloaded to a local temporary path for the session.
- Shared attachment size limits are enforced.

## Unbind

Unbinding the WeChat account clears its credentials and platform authorization lists. Removing one paired user only revokes that user.

## Development

Packaged Desktop starts the sidecar automatically. For source development:

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

If messages are rejected, confirm that Desktop is running, the account is bound, the sender is paired or allowlisted, and both adapter state files are writable.
