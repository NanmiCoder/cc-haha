# Feishu Integration

The Feishu adapter connects an enterprise custom app to local Desktop sessions. It handles `p2p` private chats only; group chats are not supported.

## Create the Feishu app

Feishu provides a template with the messaging, event, and card capabilities needed by this integration:

[Create a Feishu bot from the template](https://open.feishu.cn/page/openclaw?form=multiAgent)

Choose a name, create the app, and save its **App ID** and **App Secret**.

In the [Feishu developer console](https://open.feishu.cn/app?lang=en-US), create and publish a bot version. Optional menu entries can invoke:

- `/projects`
- `/new`
- `/clear`

The app must be published before users can reliably receive the configured bot behavior.

## Configure Desktop

Open **Settings → IM Integration → Feishu**:

1. Enter the App ID and App Secret.
2. Generate a six-character pairing code.
3. Save the configuration.
4. Send a private message to the bot and provide the code.

Pairing codes expire after 60 minutes, work once, and are rate limited after repeated failures. App credentials do not authorize every organization user.

## Commands

- `/help` or `帮助`
- `/status` or `状态`
- `/clear` or `清空`
- `/projects` or `项目列表`
- `/new` or `新会话`
- `/stop` or `停止`

## Permission approval

Permission requests are sent as interactive cards. Selecting allow or deny returns the result to the pending Desktop session.

If card actions do not work, confirm that the latest application version is published and includes the required card-action capability.

## Reply behavior

- Normal text uses Feishu post messages.
- Permission approval uses cards.
- Streaming output prefers patching the same message.
- Long completed content is split to respect platform limits.

## Development

Packaged Desktop starts the sidecar automatically. For source development:

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

If messages are missing, confirm that the app is published, the conversation is a private chat, and the sender is paired or explicitly allowlisted.
