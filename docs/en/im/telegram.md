# Telegram Integration

The Telegram adapter connects a BotFather bot to local Desktop sessions. It accepts private chats only; groups are not supported.

## Create a bot

In Telegram, open the official **@BotFather** account:

1. Send `/newbot`.
2. Choose a display name.
3. Choose a username ending in `_bot`.
4. Copy the Bot Token returned by BotFather.

Treat the token as a credential.

## Configure Desktop

Open **Settings → IM Integration → Telegram**:

1. Paste the Bot Token.
2. Generate a six-character pairing code.
3. Save the configuration.
4. Send a message to the new bot and provide the pairing code when prompted.

The code expires after 60 minutes, works once, and is rate limited after repeated failures. Bot configuration alone does not authorize all Telegram users.

## Commands

- `/start` — show help
- `/help` — show available commands
- `/projects` — list or switch recent projects
- `/status` — show project, model, run state, and task summary
- `/clear` — clear context while keeping the project
- `/new` — start a new session and choose a project
- `/stop` — stop the current generation

## Permission approval

Telegram presents buttons for:

- allow once;
- always allow the matching operation;
- deny.

The callback is converted to a `permission_response` for the pending Desktop session.

## Reply behavior

The adapter buffers streaming output:

- a placeholder can be sent during thinking;
- text deltas are accumulated;
- completed text is split into platform-sized messages.

## Development

Packaged Desktop starts the adapter automatically. For source development:

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

If a sender is rejected, verify that the current pairing code was sent to the correct bot private chat and that the sender is now present in the paired or allowed list.
