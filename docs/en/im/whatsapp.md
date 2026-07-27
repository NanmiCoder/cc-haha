---
title: WhatsApp Integration
nav_title: WhatsApp
description: Scan from Linked devices on your phone to attach the Desktop app as a logged-in WhatsApp Web device.
order: 5
---

# WhatsApp Integration

For users outside mainland China: no Meta developer account is required, and one QR scan lets your personal WhatsApp number drive the Desktop app. In exchange, this is a WhatsApp Web linked-device login rather than the official Cloud API — no official SLA, template messages, or broadcast capability. It handles personal private chats only, not groups, channels, or status. Permission approval is text replies.

## This is not "creating a bot"

What the integration really does is attach the Desktop app as one more logged-in Web device on your WhatsApp account. So there is no Meta for Developers app, no WhatsApp Business Account, and no Phone Number ID, access token, webhook URL, or message template review.

The person on the other side is talking to the WhatsApp account you bound, not to a separately created bot.

For customer service, template messages, an official SLA, or broadcasting, you would need the official Cloud API instead, which is a separate implementation. See the [Linked Devices help page](https://faq.whatsapp.com/1317564962315842/) and the [WhatsApp Cloud API overview](https://developers.facebook.com/docs/whatsapp/cloud-api/overview).

## Bind the account

1. Open **Settings → IM Adapters** and select the **WhatsApp** tab.
2. Select **Scan to Bind**.
3. On your phone, open **WhatsApp → Settings → Linked devices**.
4. Scan the QR code shown in Desktop.
5. Wait for the status to read **WhatsApp is bound**.

The login state is saved locally and the adapter restarts on its own; no separate save is needed. The default directory is:

```text
~/.claude/whatsapp-auth/default
```

That directory is equivalent to a credential that can send and receive messages as you. Do not share it and do not commit it.

## Authorize a sender

Linked-device login attaches the account; it does not authorize your contacts.

1. Back at the top of the page, under **Pairing**, select **Generate Code**.
2. From the account you want to authorize, send the six-character code to the bound account in a private chat.
3. Once pairing is confirmed, that JID is recorded in the local authorization list.

Known JIDs can instead be entered in **Allowed Users** as a country code plus phone number:

```text
15551234567@s.whatsapp.net
```

Codes are valid for 60 minutes, work once, and are invalidated when a new one is generated.

## Commands

- `/start` or `/help` — show help and available commands
- `/projects` — list recent projects and switch
- `/status` — current project, model, and run state
- `/new [project]` — start a new session or switch projects
- `/clear` — clear context, keep the project binding
- `/stop` — stop the current generation

## Approval and reply behavior

WhatsApp has no tappable buttons, so a permission request is answered by replying as the message instructs:

- `1` or `/allow <requestId>` — allow once
- `2` or `/always <requestId>` — persist the matching approval
- `3` or `/deny <requestId>` — deny

The adapter does not rely on repeatedly editing one message for token-level streaming: a short status message is sent while Claude thinks, completed text is split into platform-sized messages, and Markdown image output is recognized and sent as an image message.

## Unbind

**Unbind WhatsApp account** removes the locally stored login state, after which you have to scan again. To revoke a single person instead, select **Unbind** next to their name under **Paired Users**; the account link itself is unaffected.

## Development

Packaged Desktop starts the sidecar automatically. Run it by hand only when working from source:

```bash
cd adapters
bun install
bun run whatsapp
```

Optional overrides:

```bash
export WHATSAPP_AUTH_DIR="$HOME/.claude/whatsapp-auth/default"
export WHATSAPP_ACCOUNT_JID="15551234567@s.whatsapp.net"
export ADAPTER_SERVER_URL="ws://127.0.0.1:3456"
```

## Troubleshooting

**The adapter reports no bound account.** Complete QR binding in Desktop first; `bun run whatsapp` has no login UI of its own.

**Still unauthorized after binding.** Scanning binds the account, not the sender. Generate a pairing code and send it from the chat you want to authorize.

**WhatsApp reports a logout.** Unbind in Settings and scan again. Removing the device under **Linked devices** on your phone also logs it out.

## Source

`index.ts`, `protocol.ts`, `session.ts`, and `media.ts` under `adapters/whatsapp/`, plus `pairing.ts`, `session-store.ts`, and `ws-bridge.ts` under `adapters/common/`.
