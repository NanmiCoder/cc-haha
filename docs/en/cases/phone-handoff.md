---
title: Continue a session on your phone
nav_title: Phone handoff
description: Enable H5 on a trusted local network, pair your phone, and continue a task running on your computer.
order: 5
---

# Continue a session on your phone

A long task is running on your computer and you need to step away. H5 lets your phone browser see the same session, answer questions, and respond to permission requests. The work still runs on the computer.

## Before you start

- Connect phone and computer to the same trusted local network. Keep the desktop app open and the computer awake.
- Have an existing desktop session. For the first trial, use a project without sensitive data and ask a read-only question such as “Read the README and list the first three things I should know.”
- H5 is off by default. [Phone and messaging access](../desktop/remote.md) explains tokens, fixed ports, and public access.

## Steps

1. On the computer, open **Settings → H5 access**, enable H5, and confirm the notice. Click **Generate token** to show a QR code and link.
2. Scan the code with your phone and open it in your usual system browser. After the first successful verification, the browser remembers the connection. If it cannot connect, check that **Access host / IP** is your computer's address on this network.
3. Open the existing session from the phone's session list and verify that you see the replies already shown on the computer. Send:

```text
Summarize the previous answer in three points: what should I do first, what is unconfirmed, and what information do you need from me next? Summarize only; do not edit files.
```

4. Return to the computer and confirm that the phone message and reply appear in the same desktop session. When the trial is over, turn H5 off in Settings if you do not need remote access for now.

## Expected result

Phone and desktop show the same session. A message sent from the phone appears in the desktop session and the reply syncs back. A task already running on the computer can continue during a brief phone disconnect or lock; reconnect to see its result.

## Acceptance and common snags

- If the phone cannot connect, check that the app is still running, the computer is awake, and the devices can reach each other. Then check the IP and port shown in Settings. Changing Wi-Fi may change the address.
- The QR code and link contain access credentials. Do not post them in chats or public screenshots. If exposed, **regenerate the token** on the desktop; the old link stops working.
- H5 supports sessions and some settings, but not the desktop workspace, embedded terminal, or Computer Use authorization UI. Review diffs and use desktop-only controls back on the computer.
- For access outside your local network, read the [public pairing and privacy guidance](../desktop/remote.md) first. Do not publish the local-network link.
