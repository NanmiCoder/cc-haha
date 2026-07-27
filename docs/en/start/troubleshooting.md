---
title: Won't install, won't open, won't connect
nav_title: Troubleshooting
description: Organized by symptom — install failures, blank window, model 401s, stuck sessions, port conflicts, phone access.
order: 4
---

# Won't install, won't open, won't connect

Find your symptom below. Each entry is "what you see → why → what to do".

First, one check: make sure you're on the latest stable build from [GitHub Releases](https://github.com/NanmiCoder/cc-haha/releases/latest). A lot of problems on older versions are already fixed.

## Won't install

### macOS says the app is damaged and can't be opened

**Why** — The file isn't damaged. macOS quarantines downloads and refuses to launch anything without an Apple signature, but words the error as "damaged", which sends everyone down the wrong path.

**What to do** — Download `install-macos-unsigned.sh` from the same Release, put it in the same folder as the DMG, and run `bash install-macos-unsigned.sh`. Or, if the app is already in Applications, run `xattr -dr com.apple.quarantine "/Applications/Claude Code Haha.app"`. Full details in [Download and install](./install.md).

### Windows shows a SmartScreen warning

**Why** — Unsigned installers get flagged by SmartScreen.

**What to do** — Confirm the file came from this repository's Releases, then click "More info" → "Run anyway". If the filename or origin doesn't match, don't bypass it.

### The Windows installer says the program is still running

**Why** — The old version's main process, sidecar, embedded terminal, or IM adapter hasn't fully exited, so the installer won't overwrite it.

**What to do**

1. Quit the main window, and quit the tray icon too.
2. Give background processes a few seconds to exit.
3. Still stuck? End any remaining Claude Code Haha processes in Task Manager.
4. Run the installer again. **Don't** use "Run as administrator", and **don't** manually delete data from the old install directory.

### The Linux AppImage does nothing when I run it

**Why** — Usually a missing execute bit, or missing FUSE.

**What to do** — Run `chmod +x <name>.AppImage` first. If you still get a FUSE error, install `libfuse2` on Ubuntu 22.04 and earlier, or `libfuse2t64` on 24.04 and later.

## Won't open

### Nothing happens when I launch it

**Why** — Most often the wrong CPU architecture: `mac-x64` on Apple Silicon, or `win-x64` on ARM64 Windows.

**What to do** — Re-check your architecture against [Download and install](./install.md) and reinstall the right package. An old version still running in the background can also block startup, so quit everything first.

### The window opens but stays blank

**Why** — The interface assets didn't load, usually after an interrupted upgrade or because a graphics driver issue prevented the renderer process from starting.

**What to do**

1. Fully quit the app (not just close the window) and reopen it.
2. Still blank? Reinstall the same version over the top. Sessions and configuration live under `~/.claude`, not in the application directory, so nothing is lost.
3. Still blank after that, it's failing during startup. File an issue at [GitHub Issues](https://github.com/NanmiCoder/cc-haha/issues) with your OS version, CPU architecture, and installer filename.

:::warning
Never delete `~/.claude` while troubleshooting. Your sessions, provider configuration, skills, agents, and memory are all in there, and they don't come back.
:::

### My session list is empty after updating

**Why** — Almost certainly not data loss. The sidebar list is served by a local SQLite index, which is derived data that can be rebuilt; the original sessions are still stored as JSON / JSONL files. While the index rebuilds, the list looks empty.

**What to do** — Open Settings → Diagnostics → Local index and check whether it's still building; let it finish. If there are degraded sources or an error code, click "Rebuild local index" — that only rebuilds the index and leaves conversations and settings untouched.

## Model 401s and connection failures

### 401 / 403 / "API Key invalid"

**Why** — The auth method doesn't match the provider, or the key itself is wrong.

**What to do** — Open Settings → Providers, edit the entry, and check in order:

1. Is **Base URL** the API root rather than the marketing site?
2. Is **Auth Variable** correct? Third-party Anthropic-compatible services almost always want `Bearer Token (ANTHROPIC_AUTH_TOKEN)`; only direct Anthropic access uses `API Key (ANTHROPIC_API_KEY)`. If unsure, try both.
3. Did the **API Key** pick up stray whitespace, or has it expired or run out of credit?
4. Save, click "Test", and verify with a fresh session once it passes.

Don't hand-edit `settings.json` for any of this — changes made in the app sync automatically.

### 404, or "model not found"

**Why** — A duplicated path segment in the URL, or a model ID borrowed from another platform.

**What to do** — Check the base URL for repetition (if it already ends in `/anthropic`, don't append `/v1/messages`). Use the exact model ID string from the provider's console, not the product name.

For local models (LM Studio / Ollama), **do not append `/v1` to the base URL** — that's the single most common source of 404s.

### 400, or "unsupported parameter"

**Why** — A third-party gateway is rejecting beta-shaped API requests, or the model doesn't support `tool_reference`.

**What to do** — Edit the provider and check "Disable experimental beta headers". If that isn't enough, turn off "Enable Tool Search". Both switches exist for exactly these gateways.

### Signed in, but the model I want isn't in the selector

**Why** — Which models you see is determined by your account entitlements, region, and plan — not by the app.

**What to do** — Refresh the provider status and reopen the model selector. If it's still missing, trust the provider's own console over anything else.

### It talks endlessly but never edits a file

**Why** — The model's tool-calling isn't strong enough to sustain an agent workflow. Small local models do this a lot.

**What to do** — Try a model with solid function-calling support. Also confirm you aren't in Plan mode, which forbids touching files by design.

### OAuth sign-in hangs

**Why** — The authorization callback isn't reaching the running app.

**What to do** — Keep the app running through the whole flow; complete the authorization in your system browser with the same account; disable proxies and blocking extensions; and check that your system clock is correct, since a skewed clock breaks the handshake. If the browser never opens, click "Copy authorization link" and paste it manually.

## Sessions that hang

### It spins forever without producing anything

**Why** — Could be a network hiccup, or an upstream that never properly closed the response.

**What to do** — In this order; don't jump straight to restarting:

1. Wait ten or fifteen seconds in case it's transient.
2. Click stop, or press `Cmd/Ctrl + .`.
3. Open the activity panel and check the real state of background tasks and subagents — a quiet main conversation doesn't mean the background is idle.
4. Switch to another session and back to rule out a stale view.
5. If none of that helps, fully quit and reopen the app.
6. Copy the error summary from Settings → Diagnostics.

### I can't change permission mode mid-session

**Why** — This is deliberate. Changing permissions mid-turn would leave the UI showing something different from what's enforced.

**What to do** — Wait for the turn to end, or stop it first, then switch.

### I denied an edit and I'm not sure whether the file changed

**Why** — Denied writes never reach the disk, but what the UI displays and what's on disk are separate things.

**What to do** — Run `git status` and `git diff` before shipping. Disk and Git are the source of truth.

## Port conflicts

**What you see** — H5 won't load, or the local service doesn't come up after launch.

**Why** — The local server defaults to port `3456`. If something else already holds that port, the service moves elsewhere or fails to start.

**What to do** — Open Settings → H5 Access and read "Current port" — it may have already moved, leaving your old QR code pointing at the wrong place. If you need a stable address (for a bookmark or a reverse proxy), set "Fixed port" on the same page, anywhere in 1024–65535. Port changes apply after restarting the app.

## Phone won't connect

**What you see** — Scanning the QR code opens nothing, or you get an unauthorized error.

**Why** — Address, port, token, and network all have to line up. Any one of them being wrong breaks the connection.

**What to do** — Go through Settings → H5 Access:

1. Is H5 access actually switched on?
2. Does "Access host / IP" still match your computer's current network interface? It changes when you switch Wi-Fi.
3. Does the port in the QR code match "Current port"?
4. Are the phone and computer on the same local network?
5. Does your firewall allow that port?
6. Has the token been regenerated? **The moment you regenerate it, every old QR code is dead.**

If you changed the fixed port, restart the app. Full deployment guidance and security boundaries are in [Phone and IM handoff](../desktop/remote.md).

### Does locking my phone kill a running task?

No. A brief disconnect doesn't stop work in progress — it finishes in the background and you'll see the result when you reconnect. Only when a task is already idle *and* no client is connected does the disconnect grace timer stop the corresponding CLI (30 seconds by default).

That's not a promise it will never drop, though. System sleep, process exit, proxy failures, and service restarts all still end the connection.

### I scanned the IM QR code but my contacts still can't talk to it

Scanning only binds the platform account; it doesn't authorize everyone who can message you. Each person still has to send the one-time pairing code generated in the desktop app, or be added to the allowlist. With both empty, access is denied by default. Per-platform differences are in [IM integrations](../im/index.md).

## Computer Use does nothing

**What you see** — You ask it to click something or control another app, and it says it can't, or simply doesn't move.

**Why** — Computer Use has a chain of prerequisites and won't run unless every link passes. It supports macOS and Windows only — **there is no Linux support**.

**What to do** — Open Settings → Computer Use and find the first item that isn't green:

1. Is the toggle at the top on? (With it off, new sessions never get these tools at all.)
2. Did the Python 3 check pass? If not, install it, or point "Python Interpreter Path" at one you already have — conda and pyenv both work.
3. Are the virtual environment and dependencies ready and installed? If not, click "Install Environment".
4. On macOS, both "Accessibility Permission" and "Screen Recording Permission" must show as granted. Grant them under System Settings → Privacy & Security.
5. **Restart Claude Code Haha after granting them.** System permissions don't apply to an already-running process.
6. Is the app you want to control listed under "Authorized Apps"?

Full details in [Computer Use](../desktop/computer-use.md).

## Still stuck

Go to Settings → Diagnostics:

1. Click "Copy issue report" for a structured snapshot of the current state.
2. Search [GitHub Issues](https://github.com/NanmiCoder/cc-haha/issues) for the same problem before opening a new one.
3. If the report alone isn't enough to diagnose it, click "Export Bundle" and attach that too.

Including these makes a fix much faster: app version, OS and CPU architecture, installer filename, which kind of provider you're using (**never paste an API key**), the shortest reproduction steps, the full error text, and whether the problem is in the desktop app, on the phone, or in the CLI.

:::warning
Diagnostic reports make a real effort to omit chat content, file contents, full environment variables, and API keys — but they can still include local paths and provider hostnames. **Read one before you share it.**
:::
