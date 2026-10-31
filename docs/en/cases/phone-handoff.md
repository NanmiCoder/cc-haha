---
title: Continue a session on your phone
nav_title: Phone handoff
description: Open Phone connection and use a browser on the same Wi-Fi to continue a task running on your computer.
order: 5
---

# Continue a session on your phone

A long task is running on your computer and you need to step away. Open **Phone connection** in the desktop's left sidebar and scan with your phone browser to see the same session, answer questions, and respond to permission requests. The work still runs on the computer.

You can also install the cc-haha mobile app: download the APK from [GitHub Releases](https://github.com/NanmiCoder/cc-haha/releases/latest) on Android, or join through the [TestFlight public link](https://testflight.apple.com/join/Nd49JrWZ) on iPhone. It needs desktop v0.7.6 or later. The steps below use the phone browser, with no app installation required. Connect directly on the same Wi-Fi, or use the desktop-managed Cloudflare tunnel while away; no phone VPN is needed.

## Before you start

- Connect phone and computer to the same trusted local network. Keep the desktop app open and the computer awake.
- Have an existing desktop session. For the first trial, use a project without sensitive data and ask a read-only question such as “Read the README and list the first three things I should know.”
- Browser access is off by default. [Mobile App, H5, and IM](../desktop/remote.md) explains app availability, access tokens, and connecting away from home.

## Steps

1. On the computer, open **Phone connection** in the left sidebar, or go to **Settings → Phone connection**. Select **Use phone browser**, or choose **Same Wi-Fi**. This selects the connection method; you still need to enable it yourself.
2. Turn on **Enable local connection** and confirm the notice to show a QR code and link. If an older configuration has no access token, click **Generate token** first.
3. Scan the code with your phone camera and open it in your usual system browser. After the first successful verification, the browser remembers the connection. If it cannot connect, check that **Access host / IP** is your computer's address on this network.
4. Open the existing session from the phone's session list and verify that you see the replies already shown on the computer. Send:

```text
Summarize the previous answer in three points: what should I do first, what is unconfirmed, and what information do you need from me next? Summarize only; do not edit files.
```

5. Return to the computer and confirm that the phone message and reply appear in the same desktop session. When the trial is over, turn off **Enable local connection** under **Phone connection → Same Wi-Fi** if you will not be using it for now.

## Expected result

Phone and desktop show the same session. A message sent from the phone appears in the desktop session and the reply syncs back. A task already running on the computer can continue during a brief phone disconnect or lock; reconnect to see its result.

## Acceptance and common snags

- If the phone cannot connect, check that the app is still running, the computer is awake, and the devices can reach each other. Then check the IP and port shown in Settings. Changing Wi-Fi may change the address.
- The QR code and link contain access credentials. Do not post them in chats or public screenshots. If exposed, **regenerate the token** on the desktop; the old link stops working.
- H5 supports sessions and some settings, but not the desktop workspace, embedded terminal, or Computer Use authorization UI. Review diffs and use desktop-only controls back on the computer.
- Away from home or on cellular data, follow [Cloudflare remote connection](../desktop/remote.md#cloudflare-remote-connection) to enable the desktop tunnel and pair your phone. Keep the local-network link within your trusted LAN.
