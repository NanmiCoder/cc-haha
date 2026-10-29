---
title: Mobile App, H5, and IM
nav_title: Phone and IM
description: Open Phone connection to continue tasks in a browser, check mobile app availability, and set up access away from home.
order: 9
---

# Mobile App, H5, and IM

A task is running on your computer and you want to check on it, or add one more instruction, from your phone. Open **Phone connection** in the desktop's left sidebar, or go to **Settings → Phone connection**. You can connect with your phone's browser now, while the mobile app is awaiting release.

## cc-haha mobile app availability

| How to open cc-haha on your phone | Availability | How to get started |
|---|---|---|
| cc-haha Android app | Officially signed APK awaiting release | A download will be provided after release |
| cc-haha iPhone / iPad app | TestFlight invitations not yet open | An installation invitation will be provided when testing opens |
| Phone browser (H5) | Available now | Select **Use phone browser**, then enable the connection and scan as described below |

**Use phone browser** selects **Same Wi-Fi**. You still need to read the notice and enable the connection yourself. When your phone and computer share a trusted Wi-Fi network, no Tailscale installation is needed. Use **Tailscale remote access** below when connecting over cellular data or another Wi-Fi network.

Keep the computer on, awake, and running cc-haha. Tasks always execute on the computer. Tailscale connects your devices while away; the cc-haha mobile app and browser let you check tasks and respond to approvals.

To chat from WeChat, DingTalk, WhatsApp, Telegram, or Feishu, see **IM Adapters** at the end of this page.

## H5 Access

### Turning it on

1. Open **Phone connection** in the desktop's left sidebar, or go to **Settings → Phone connection**.
2. Select **Use phone browser**, or choose **Same Wi-Fi**.
3. Turn on **Enable local connection** and confirm after reading the warning.
4. Scan the QR code with your phone camera and open it in your usual Safari, Chrome, or system browser. You can also copy the launch URL to your own device.

If an older configuration has no saved token, click **Generate token** to show a new QR code.

The scanned link carries the server address and token. Scan with your phone camera and open it in your usual Safari, Chrome, or system browser. Successful verification stores the connection in that browser's localStorage and removes the token from the address bar. Scanning again or opening a bookmark reconnects automatically. Temporary network failures do not forget pairing; choose **Retry** to use the saved credential. A revoked or regenerated token requires a fresh QR code.

![Reading a real project conversation on mobile (Chinese interface)](../../images/app/en/h5-session.webp)

### The token is the credential

Anyone holding that link can reach what your desktop exposes. So:

- Never paste a link containing the token into a group chat, a public issue, a log screenshot, or any public page.
- Only enable it on networks you trust. Outside your LAN, use **Tailscale remote access** below for HTTPS and individual device pairing.
- If you suspect a leak, click **Regenerate token**. The old QR code and old token stop working immediately. Turning H5 off and on again does *not* rotate the token.

Turn it off when you're not using it. That immediately rejects remote access while keeping the token, so the same one still works next time.

:::warning
H5 is off by default, and it isn't a public service. Confirm you're on a network you trust before enabling it.
:::

### Access host and fixed port

**Access host / IP** takes your computer's current LAN IP, e.g. `192.168.1.20`, on the current service port. After switching Wi-Fi or unplugging Ethernet the old IP may no longer be yours; the page notices and offers the working one.

LAN H5 also accepts a full URL with the corresponding **Allowed origins** configuration. That remains the existing H5 token access mode. To connect the mobile app or browser from another network, use **Tailscale remote access** below and forward Serve to its separate, restricted gateway instead of mapping the desktop's main service port.

Usually you can turn on the connection and scan without entering an IP or port. Open **Advanced connection settings** only when you need a manual override. A **fixed port** here keeps the LAN address stable or works with a LAN firewall or reverse proxy. The port must be between 1024 and 65535, and the change takes effect after a restart — the page tells you which port is currently live in the meantime. It is independent of the remote entry's local port below.

### Locking your phone won't kill the task

That's what **Disconnect grace** is for: when your phone locks, backgrounds the tab, or drops off the network briefly, **a running task is not stopped**. It finishes in the background and the result is waiting when you reconnect.

Only when a task is idle *and* nothing is connected does the CLI process stop, after the grace period. The default is 30 seconds and the valid range is 5 seconds to 24 hours. Raise it — say to 600 — if you're operating remotely for a while.

### What works on a phone

Session list and project switching, sending messages, stopping, streaming replies, image and file attachments, permission buttons, questions from Claude, `@` file references, copy and fork — the whole conversation flow.

The **Settings** entry at the bottom of the sidebar provides **Model providers** and **General**. Add, edit, delete, reorder, or switch providers on your phone. Existing API keys are never returned; leave a key blank while editing to keep it. Changing a model or image request URL requires entering the corresponding API key again, so saved credentials are not automatically sent to a new address. General settings include theme, interface language, response language, output style, reasoning effort, send behavior, thinking, and workflow keywords. Theme and interface language affect this browser; Agent preferences are shared with the computer.

Provider website login, configuration import, and desktop administration remain on the computer. The desktop workspace, embedded terminal, native "open with", Computer Use authorization, and the desktop pet are not part of H5. Remote terminal execution is deferred: the current terminal is owned by Electron and requires a separate device-authorized transport with reconnect and revocation support.

## Tailscale remote access

Keep using LAN scanning when your devices share a local network. Away from home or the office, connect your phone and computer through your own **Tailscale** network, then connect cc-haha. You do not need to rent a server, register a domain, or configure ngrok. Tailscale handles connectivity; cc-haha still handles phone pairing and authorization.

### 1. Download Tailscale and connect both devices

Install **Tailscale** once on your computer and once on your phone. Choose the official download for each device below:

| Device | Download / install | What to do next |
|---|---|---|
| macOS computer | [Download macOS installer (.pkg)](https://pkgs.tailscale.com/stable/Tailscale-latest-macos.pkg) | Open the package, follow the installer, and open Tailscale; this standalone version is recommended |
| Windows computer | [Download Windows installer (.exe)](https://pkgs.tailscale.com/stable/tailscale-setup-latest.exe) | Run the installer; it selects the right version for your system automatically. Keep an internet connection during installation |
| Android phone | [Download Android installer (.apk)](https://pkgs.tailscale.com/stable/tailscale-android-universal-latest.apk) · [Install from Google Play](https://play.google.com/store/apps/details?id=com.tailscale.ipn) | Open the link on your phone; for an APK, allow your browser to install apps when Android asks |
| iPhone / iPad | [Install from the App Store](https://apps.apple.com/us/app/tailscale/id1470499037?ls=1) | Open the link on your phone and tap **Get**; the app must be available in your Apple account's store region |

If you are reading on a computer, open this guide in your phone's browser to use its installation link. **Phone connection → Away from home** in the desktop app also provides Tailscale downloads grouped by platform.

Tailscale hosts these installers, and the download links resolve to the current stable release. Android APK installations require manual updates; Google Play is easier for automatic updates when available. For other platforms, older systems, or special installation requirements, see the [official download page](https://tailscale.com/download) and [installation guide](https://tailscale.com/docs/install).

For iPhone and iPad, the supported installation path is the App Store; Tailscale does not provide a standalone IPA for general installation. If the store says the app is unavailable in your region, see [Tailscale's explanation](https://github.com/tailscale/tailscale/issues/19625). You can still use the same-Wi-Fi connection above without Tailscale.

After installing, open Tailscale on your computer and phone, **sign in with the same account, and keep both connected**. Allow the VPN configuration when prompted; macOS may also ask you to enable a network extension. See the [official quickstart](https://tailscale.com/docs/how-to/quickstart) for account and sign-in help.

Use **Tailscale Serve** to make the address available to authorized devices in your private network. You do not need public Funnel access, an exit node, or a subnet router. See the [Serve guide](https://tailscale.com/docs/features/tailscale-serve) for how this works.

### 2. Configure the computer

Run the following commands **on the computer only**; no commands are needed on the phone. Prepare a command window first:

- **macOS:** press `⌘ + Space`, search for **Terminal**, and open it. In Tailscale, open **Settings → CLI integration → Show me how → Install Now**, enter your computer's administrator password when prompted, then return to Terminal. If you already use the App Store version, replace `tailscale` at the start of each command below with `/Applications/Tailscale.app/Contents/MacOS/Tailscale`. See the [macOS CLI instructions](https://tailscale.com/docs/reference/tailscale-cli?tab=macos).
- **Windows:** search for **PowerShell** in the Start menu and open it. If PowerShell was open before you installed Tailscale, close and reopen it before pasting commands. See the [Windows CLI instructions](https://tailscale.com/docs/reference/tailscale-cli?tab=windows).

1. Open **Phone connection → Away from home** in the desktop app. Keep the default local port, `17463`, or select an unused port.
2. Paste the following command into the computer's command window and press Enter to check existing forwards:

   ```sh
   tailscale serve status
   ```

   If HTTPS port `443` is unused, run the command below. If another Serve service already uses it, use the alternative port example below to preserve that service.

   ```sh
   tailscale serve --bg http://127.0.0.1:17463
   ```

3. The first run may provide a browser link. Follow it to enable HTTPS for your Tailscale network. If DNS setup is missing, enable MagicDNS and HTTPS Certificates using the [official HTTPS guide](https://tailscale.com/docs/how-to/set-up-https-certificates). Serve manages certificates; you do not need to download certificate files.
4. Copy the HTTPS address printed by the command, such as `https://my-computer.example.ts.net`, into **Tailscale HTTPS address**. Use your actual address without `/remote`, query parameters, or a pairing code. Do not enter `http://100.x.x.x`.
5. Read the access notice and enable the connection entry. **Local entry ready** means cc-haha is accepting connections locally; it does not verify the phone-to-computer network.

The command's `17463` must match the local port shown in settings. This is cc-haha's separate, restricted gateway, not the desktop's main service port. The command shown in the app updates with your port settings.

If another Serve service already uses HTTPS `443`, choose a different unused port, for example:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:17463
```

Include `:8443` in the app's address too, such as `https://my-computer.example.ts.net:8443`. Forward the root path, not just `/remote`: pages, API requests, and WebSocket connections share this entry. See the [Serve command reference](https://tailscale.com/docs/reference/tailscale-cli/serve).

### 3. Scan and approve

1. Keep Tailscale connected on the phone. Turn off Wi-Fi and use cellular data to check the remote path.
2. Scan the desktop pairing QR code with your phone camera and open your usual browser. When using the cc-haha mobile app, you can also scan from inside the app.
3. Approve the phone on the desktop. Once paired, the phone saves the connection and can show tasks and approvals.

After upgrading from ngrok, the old remote entry does not start automatically. Previously configured Tailscale HTTPS addresses also need fresh consent before enabling. An old ngrok address cannot connect through Tailscale; generate a new QR code to pair. LAN configuration and existing computer sessions are unaffected.

### Troubleshooting

| Symptom | What to check |
|---|---|
| The desktop says ready, but the phone cannot connect | Both Tailscale clients must be connected to the same private network. Check the HTTPS address and port against Serve's output, and keep cc-haha running on the computer. |
| Address or certificate errors | Check MagicDNS, HTTPS Certificates, and `tailscale serve status`. Use the full HTTPS hostname instead of a `100.x.x.x` address. |
| Another VPN disconnects when Tailscale starts | Mobile systems generally permit only one active VPN. See [VPN compatibility](https://tailscale.com/docs/reference/faq/other-vpns). |
| Connected, but streaming is slow | Inspect `tailscale status` / `tailscale ping` for a direct or relayed connection. Relay routing affects latency. Test the actual carrier and cellular network; LAN performance is not sufficient evidence. See [connection types](https://tailscale.com/docs/reference/connection-types). |
| No system notification after backgrounding | Tailscale provides connectivity, not push notification delivery. Push requires separate configuration; reopening the app synchronizes task state. |

### Pairing, stopping, and recovery

Pairing codes expire after 5 minutes and are single-use. Phone credentials last 30 days by default. Keep QR codes private. Revoke an individual phone or disable the remote entry to disconnect remote clients immediately; running tasks continue.

When connectivity recovers and the HTTPS address stays the same, the mobile app reconnects with its saved credential and synchronizes sessions. Temporary outages or entry restarts do not invalidate authorization or require another scan. Expired or revoked authorization requires pairing again; the current implementation does not automatically extend the 30-day lifetime.

The mobile app stores credentials in secure system storage. Browsers use a secure cookie; rescanning while it is valid does not consume another QR code. Browsers, private windows, and hostnames do not share authorization. If a scanner opens an embedded browser, switch to your usual browser before pairing.

The remote entry supports the provider and General settings described above. Unrestricted directory browsing and path-based file previews remain desktop-only; session-scoped file and review APIs remain available.

Automatic restoration on desktop startup is off by default and only restores cc-haha's local entry. Serve's `--bg` configuration persists and resumes after Tailscale restarts. Both devices still need Tailscale connected, and the computer must remain on, online, and awake. Closing cc-haha or putting the computer to sleep prevents connections and new tasks. See [Serve restart behavior](https://tailscale.com/docs/reference/tailscale-cli/serve#effects-of-rebooting-and-restarting).

Disabling the cc-haha entry does not remove your Tailscale configuration. To also stop the default HTTPS `443` forwarding, run `tailscale serve --https=443 off` on the computer; use `--https=8443` if you configured that port. Avoid `tailscale serve reset`, which clears other Serve configuration too.

## IM Adapters

![Settings → IM Adapters: platform tabs and the Slack setup form (Chinese interface)](../../images/app/en/settings-im.webp)

**Settings → IM Adapters** supports eight platforms, each connected differently. These are the common setup paths; see the [messaging guide](../im/index.md) for full steps:

| Platform | How to connect |
|---|---|
| WeChat | Generate a QR code in settings and scan it with WeChat to bind the account |
| DingTalk | Scan to create and authorize a bot in one step, or fill in Client ID / Secret manually |
| WhatsApp | Generate a QR code and scan it under **Linked devices** in WhatsApp |
| Telegram | Get a bot token from @BotFather and paste it in |
| Feishu | Enter an App ID and App Secret; if you don't have a bot, the page can create one from a template |
| WeCom | Scan in settings to create an intelligent bot |
| QQ | Scan to authorize, then provide the App ID and App Secret |
| Slack | Create an app from the supplied manifest, then enter two tokens |

### Binding an account is not the same as allowing a person

This is the step people miss: **scanning only binds the account's messaging capability. Who is allowed to talk to the bot is a separate question.**

Under **Pairing**, click **Generate pairing code**, then send that code to the bot in a direct message from your own IM account. That completes the binding. Alternatively, list user IDs under **Allowed users**.

When both are empty, everyone is denied — that's deliberate, not a bug.

Paired users are listed below and can be unbound at any time; unbinding requires pairing again.

### Other settings

- **Default project** — the working directory for new IM sessions. Left empty, it uses your current user working directory. It's only a starting point — it doesn't restrict which projects the bot can reach.
- **Allowed project directories** — the boundary for the bot: `/projects` only lists projects inside these directories. Left empty, it defaults to your home directory (plus the default project, if it is outside home).
- **Streaming card mode** — updates the message content live, so it reads more like watching it type.
- **Permission requests** — DingTalk can use an interactive card template ID for button-based approval. Without it, every platform falls back to the `/allow`, `/always`, and `/deny` text commands.

For each platform's application flow, permission configuration, and troubleshooting, see [IM integrations](../im/index.md).
