---
title: Phone (H5) and IM
nav_title: Phone and IM
description: Continue a session in your phone's browser, or chat from WeChat, Feishu, or Telegram.
order: 9
---

# Phone (H5) and IM

A task is running on your computer and you want to check on it, or add one more instruction, from your phone. Two routes:

- **H5 Access** — open the same interface in a mobile browser: sessions, messages, attachments, permission buttons, all of it.
- **IM Adapters** — talk to Claude directly inside WeChat, DingTalk, WhatsApp, Telegram, or Feishu.

Both require your computer to be on with the app running. They expose the local desktop service; they don't move anything to a cloud.

## H5 Access

![Settings → H5 Access: QR code and token](../../images/app/settings-h5.webp)

### Turning it on

1. Open **Settings → H5 Access**.
2. Turn on **Enable H5 access** and confirm after reading the warning.
3. Click **Generate token**. A QR code and an H5 link appear.
4. Scan it with your phone, or click **Copy launch URL** and send it to your own device.

The scanned link carries the server address and the token. Once your phone's browser connects, it remembers the connection and later visits go straight in.

![The mobile conversation view with a file-changes card](../../images/app/h5-session.webp)

### The token is the credential

Anyone holding that link can reach what your desktop exposes. So:

- Never paste a link containing the token into a group chat, a public issue, a log screenshot, or any public page.
- Only enable it on networks you trust. For anything reachable from the internet, put HTTPS, a VPN, or access control in front of it — don't rely on one long-lived token.
- If you suspect a leak, click **Regenerate token**. The old QR code and old token stop working immediately. Turning H5 off and on again does *not* rotate the token.

Turn it off when you're not using it. That immediately rejects remote access while keeping the token, so the same one still works next time.

:::warning
H5 is off by default, and it isn't a public service. Confirm you're on a network you trust before enabling it.
:::

### Access host and fixed port

**Access host / IP** takes your computer's current LAN IP, e.g. `192.168.1.20`, on the current service port. After switching Wi-Fi or unplugging Ethernet the old IP may no longer be yours; the page notices and offers the working one.

If you run your own reverse proxy, put the full URL here instead — `https://cc.example.com` — and add that origin to **Allowed origins**.

A **fixed port** is worth setting when a phone bookmark has to stay valid, a firewall only opens specific ports, or Nginx or Caddy forwards to one fixed upstream. The port must be between 1024 and 65535, and the change takes effect after a restart — the page tells you which port is currently live in the meantime.

### Locking your phone won't kill the task

That's what **Disconnect grace** is for: when your phone locks, backgrounds the tab, or drops off the network briefly, **a running task is not stopped**. It finishes in the background and the result is waiting when you reconnect.

Only when a task is idle *and* nothing is connected does the CLI process stop, after the grace period. The default is 30 seconds and the valid range is 5 seconds to 24 hours. Raise it — say to 600 — if you're operating remotely for a while.

### What works on a phone

Session list and project switching, sending messages, stopping, streaming replies, image and file attachments, permission buttons, questions from Claude, `@` file references, copy and fork — the whole conversation flow.

The desktop workspace, embedded terminal, native "open with", Computer Use authorization, and the desktop pet are not part of H5.

## IM Adapters

![Settings → IM Adapters: pairing and the five platforms](../../images/app/settings-im.webp)

**Settings → IM Adapters** supports five platforms, each connected differently:

| Platform | How to connect |
|---|---|
| WeChat | Generate a QR code in settings and scan it with WeChat to bind the account |
| DingTalk | Scan to create and authorize a bot in one step, or fill in Client ID / Secret manually |
| WhatsApp | Generate a QR code and scan it under **Linked devices** in WhatsApp |
| Telegram | Get a bot token from @BotFather and paste it in |
| Feishu | Enter an App ID and App Secret; if you don't have a bot, the page can create one from a template |

### Binding an account is not the same as allowing a person

This is the step people miss: **scanning only binds the account's messaging capability. Who is allowed to talk to the bot is a separate question.**

Under **Pairing**, click **Generate pairing code**, then send that code to the bot in a direct message from your own IM account. That completes the binding. Alternatively, list user IDs under **Allowed users**.

When both are empty, everyone is denied — that's deliberate, not a bug.

Paired users are listed below and can be unbound at any time; unbinding requires pairing again.

### Other settings

- **Default project** — the working directory for new IM sessions. Left empty, it uses your current user working directory.
- **Streaming card mode** — updates the message content live, so it reads more like watching it type.
- **Permission requests** — DingTalk can use an interactive card template ID for button-based approval. Without it, every platform falls back to the `/allow`, `/always`, and `/deny` text commands.

For each platform's application flow, permission configuration, and troubleshooting, see [IM integrations](../im/index.md).
