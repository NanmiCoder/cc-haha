# WhatsApp Integration

The WhatsApp adapter uses a personal WhatsApp Web linked-device session through `@whiskeysockets/baileys`. It is not the official WhatsApp Business Platform or Cloud API.

It handles personal private chats only. Groups, channels, and status broadcasts are not supported.

## What linked-device access means

You do not need a Meta developer app, WABA, Phone Number ID, Cloud API access token, webhook, or message template.

Instead:

1. Desktop creates a WhatsApp Web login QR code.
2. You scan it from **WhatsApp → Linked devices**.
3. Local Baileys auth state is saved.
4. The adapter observes private messages received by that account.
5. Only allowlisted or paired senders can reach a Claude Code session.

The chat recipient is the WhatsApp account you bound, not a separately created bot.

## Bind the account

Open **Settings → IM Integration → WhatsApp**:

1. Select **Scan to bind**.
2. Open **Linked devices** on the phone.
3. Scan the QR code.
4. Wait for Desktop to confirm the binding.

The default local auth directory is:

```text
~/.claude/whatsapp-auth/default
```

Do not publish or share this directory.

## Authorize a sender

Linked-device login does not authorize all contacts.

Generate a six-character pairing code in Desktop, then send it in a private WhatsApp chat to the bound account. The sender’s JID is added to `whatsapp.pairedUsers`.

Known JIDs can be entered in `Allowed Users`, for example:

```text
<country-code><phone-number>@s.whatsapp.net
```

## Commands

- `/start` or `/help`
- `/projects`
- `/status`
- `/clear`
- `/new [project]`
- `/stop`

## Permission approval

WhatsApp uses explicit text replies:

- `1` or `/allow <requestId>` — allow once
- `2` or `/always <requestId>` — persist the matching approval
- `3` or `/deny <requestId>` — deny

## Reply behavior

- Thinking can produce a short status message.
- Completed text is split into platform-sized messages.
- Recognized Markdown image output can be sent as an image message.
- The adapter does not depend on editing one WhatsApp message for token-level streaming.

## Unbind

Use the WhatsApp settings page to unbind, remove local auth state, and scan again. Removing only a paired user revokes that sender without unlinking the account.

## Development

Packaged Desktop starts the sidecar automatically. For source development:

```bash
cd adapters
bun install
bun run whatsapp
```

Optional overrides:

```bash
export WHATSAPP_AUTH_DIR="$HOME/.claude/whatsapp-auth/default"
export WHATSAPP_ACCOUNT_JID="<country-code><phone-number>@s.whatsapp.net"
export ADAPTER_SERVER_URL="ws://127.0.0.1:3456"
```

If the adapter reports that no account is bound, complete QR binding in Desktop first; the manual adapter command does not provide a separate login UI.
