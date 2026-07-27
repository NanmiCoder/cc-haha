---
title: Computer Use
nav_title: Computer Use
description: Let Claude read your screen, move the mouse, and type into other apps.
order: 7
---

# Computer Use

With Computer Use enabled, Claude can take screenshots of your screen, move the mouse, click, and type — driving applications that have no API at all: system settings, native note apps, Finder, third-party desktop software.

It acts on this computer, so read what you're authorizing before you turn it on.

macOS and Windows are supported. There is no Linux executor yet.

## Preparing the environment

![Settings → Computer Use: environment checks, the two macOS permissions, authorized apps](../../images/app/settings-computer-use.webp)

Open **Settings → Computer Use**. The top of the page is a row of environment checks:

1. **Python 3** — required on your machine. If it isn't found, click **Download Python 3**. If your Python lives in conda, pyenv, or another custom environment, pick the executable under **Python interpreter path** and it will be preferred from then on.
2. **Virtual environment** and **Dependencies** — click **Install Environment** and the app creates an isolated venv and installs the platform dependencies. Your global Python is left alone.
3. When everything is green the page says all checks passed and Computer Use is ready.

**Re-check** re-runs the detection at any time.

## The two macOS permissions

macOS additionally requires two system permissions. Neither is optional:

| Permission | What it's for |
|---|---|
| Accessibility | Moving the mouse, clicking, typing |
| Screen Recording | Taking screenshots — i.e. letting it see |

The page has **Open accessibility settings** and **Open screen recording settings** buttons that jump straight to the right pane.

:::warning
After granting either one you must **fully quit and reopen the app**. macOS reads these permissions once at process start, so without a restart the page will keep reporting them as not granted.
:::

Make sure you're granting the permission to the app that actually launches Claude Code Haha. Screen Recording detection is occasionally unreliable — if the system settings clearly show it granted but the page still says otherwise, it generally works anyway.

## Pre-authorized apps

By default, every time Claude wants to control a new app it raises a "Computer Use wants to control these apps" prompt naming the apps and the reason. You can **Allow for session** or **Deny**.

For apps you keep approving, tick them under **Authorized Apps** in settings and Claude will control them without prompting. The search box filters your installed apps.

Two more grants are separate and never come along with an app authorization:

- **Clipboard access** — reading and writing the system clipboard.
- **System key combos** — sending system-level shortcuts.

:::danger
Pre-authorization is permanent approval. Keep password managers, banking apps, and corporate chat off that list — make it ask, every time.
:::

## Getting started

Start a session and describe the goal and the allowed apps in plain language. Begin with something small and reversible:

```text
Take a screenshot and tell me what you see.
Open Notes and create an empty note titled "test".
Find the Displays pane in System Settings, but don't change anything.
```

Claude works in a screenshot → decide → act → screenshot loop, so it's slower than you are and will occasionally misclick. Explicit boundaries ("only inside app X", "don't save") work far better than a broad goal.

Only one session can drive the mouse and keyboard at a time. If you see that another session holds it, stop or finish that session first.

## Known limits

- **There is no global abort hotkey.** Use the stop button in the session (`⌘.`).
- **Windows screenshots aren't filtered.** On macOS a screenshot keeps only authorized apps and the desktop; on Windows every visible window is captured. Close or minimize anything sensitive first.
- **Browsers and terminals are restricted.** Browsers are read-only (visible but not clickable) and terminals and IDEs are click-only (no typing). Use the browser extension for web pages and the Bash tool for commands.
- **Re-screenshot after the UI changes.** Old coordinates don't survive a page change.

## Troubleshooting

**The page keeps saying permissions are missing**
Confirm you granted them to the app that actually launches Claude Code Haha, fully quit and reopen, then click **Re-check**.

**The environment won't install**
Pick an explicit Python 3 under **Python interpreter path**, confirm it supports `venv`, and click **Install Environment** again. If it still fails, check the install log in **Settings → Diagnostics**.

**Screenshots work but clicks don't**
Make sure the target app is in the authorized list and is currently in the foreground. Browsers and terminals are subject to the tier restrictions above.

For the permission tiers, the Python bridge, and the executors, see [Computer Use architecture](../internals/computer-use.md).
