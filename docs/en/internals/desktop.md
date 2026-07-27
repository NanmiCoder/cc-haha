---
title: Desktop Architecture
nav_title: Desktop
description: Process boundaries between the Electron main process, server sidecar, CLI subprocesses, and IM adapters.
order: 1
---

# Desktop Architecture

The desktop app does not embed the CLI inside React. It is four kinds of processes cooperating, and most maintenance mistakes come from crossing a boundary that was meant to stay closed.

## Process map

```text
Electron main
├── Chromium renderer (React UI)
├── claude-sidecar server
│   ├── Bun.serve HTTP API
│   ├── Bun WebSocket session gateway
│   └── CLI subprocess per session
└── claude-sidecar adapters (launched per platform)
    ├── Telegram
    ├── Feishu
    ├── WeChat
    ├── DingTalk
    └── WhatsApp
```

- **Electron main** owns windows, native dialogs, updates, terminals, native preview, pet windows, and the sidecar lifecycle.
- **Renderer** owns the interface only. It reaches native capabilities through `window.desktopHost`, exposed by preload.
- **Server sidecar** is the local service shared by the desktop app and the H5 client: REST, WebSocket, provider proxy, and session management.
- **CLI subprocess** executes model requests, tool calls, and agent orchestration.
- **Adapter sidecar** bridges IM platform messages into the same server and CLI sessions.

`desktop/src-tauri/` now only holds packaging assets and historical code. It is not the desktop runtime; Electron is the current host.

## Current stack

| Layer | Main technologies | Purpose |
|---|---|---|
| Renderer | React 18, Vite 8, TypeScript, Zustand 5 | Desktop UI and state |
| Styling and content | Tailwind CSS 4, Marked, DOMPurify, Shiki 4, Mermaid, KaTeX | Layout, Markdown, code, diagrams |
| Diff | `react-diff-viewer-continued` | Diffs in chat and workspace |
| Electron host | Electron, electron-builder, electron-updater | Native windows, packaging, updates |
| Terminal | node-pty, xterm.js | Native PTY and terminal rendering |
| Local service | Bun, `Bun.serve` | HTTP API and WebSocket |

Versions follow `desktop/package.json`. This page lists only the majors that change how the architecture reads, not the full dependency list.

## Electron host

| Path | Responsibility |
|---|---|
| `desktop/electron/main.ts` | Electron main entry, windows, IPC registration |
| `desktop/electron/preload.ts` | Typed host API exposed to the main renderer |
| `desktop/electron/preview-preload.ts` | Isolated bridge for native web preview |
| `desktop/electron/pet-preload.ts` | Minimal bridge for pet windows |
| `desktop/electron/ipc/` | IPC channel registration and payload validation |
| `desktop/electron/services/` | Sidecar, update, terminal, preview, window, and proxy services |

The renderer must not import Electron directly, and must not assemble arbitrary IPC channel names. A new native capability means updating the host contract, the main-side validation, and the related tests together.

### Startup sequence

1. Electron resolves the default or portable storage mode and prepares the app config directory.
2. The host picks a free port and starts the unified `claude-sidecar server` binary.
3. The sidecar enters `startServer()` from `src/server/index.ts` and serves HTTP and WebSocket from one `Bun.serve`.
4. Once the health check passes, the renderer takes the loopback server URL and loads sessions and settings.
5. The host starts adapter sidecars for the platforms that are configured.
6. The server starts a CLI subprocess on demand when a session begins.

The server can bind a LAN-reachable address for H5, but the desktop renderer always talks to the loopback control address. H5, remote access, and pet windows each pass their own token and capability limits. A running local server does not make every caller trusted.

### Sidecar entry point

`desktop/sidecars/claude-sidecar.ts` is the single entry point:

```text
claude-sidecar server   --app-root <path> --host <host> --port <port>
claude-sidecar cli      --app-root <path> [CLI arguments]
claude-sidecar adapters --app-root <path> --telegram|--feishu|--wechat|--dingtalk|--whatsapp
```

The sidecar sets `CLAUDE_APP_ROOT`, `CALLER_DIR`, and the launch arguments before importing any business module, because the top-level modules of the server, CLI, and adapters read those values at import time.

## Server sidecar

The real server entry is `src/server/index.ts`, not a separate `server.ts` wrapper.

```text
src/server/
├── index.ts          # Bun.serve, auth, CORS, upgrades, static H5
├── router.ts         # REST resource routes
├── api/              # API boundary
├── services/         # Sessions, providers, indexing, diagnostics
├── ws/               # WebSocket protocol and session lifecycle
├── proxy/            # Provider protocol and streaming translation
├── middleware/       # Auth, CORS, error boundary
└── config/           # Provider presets
```

A single `Bun.serve` `fetch` boundary handles:

- `/api/*` REST requests
- `/ws/:sessionId` for desktop, H5, and pet clients
- `/sdk/:sessionId` for internal CLI connections
- OAuth callbacks
- Restricted preview and local file access
- Bundled H5 static assets

Auth rules differ by client capability. Before adding a route, decide whether it belongs to the local desktop, H5, pets, the internal SDK, or public static assets, then place it inside the matching auth and CORS boundary.

## WebSocket semantics

The renderer keeps one connection per session:

```text
ws://<server>/ws/<sessionId>
```

If the server has auth enabled, the client passes the token as a connection query parameter. After the connection opens, the server sends the current session identity, a snapshot of pending permission requests, and the running state.

### Heartbeat and reconnect

Current behavior in `desktop/src/api/websocket.ts`:

- Send `ping` every 30 seconds after connecting.
- If no `pong` arrives within 10 seconds, the client closes the connection and reconnects.
- Reconnect delay grows exponentially from 1 second, capped at 30 seconds.
- Automatic reconnect has no fixed retry ceiling; only closing the session stops it.
- Messages sent while offline are queued in memory.
- After reconnecting, queued messages are flushed first, then `sync_state` fetches the server's authoritative run state.

If you have read "at most 10 retries" somewhere, that wording is stale — the list above is current.

### A disconnected client does not stop the work

After the last client disconnects:

- Foreground turns and background tasks keep running.
- The idle grace period starts only after the work finishes.
- A client reconnecting inside the grace period cancels the cleanup.
- The server stops the CLI only once the grace period passes with no clients.
- Sessions waiting on a permission request have their own bounded cleanup policy so they cannot hold a process forever.

That is why locking a phone, refreshing the renderer, or a brief network switch does not interrupt a running task.

## CLI and provider proxy

The server starts a CLI per session and forwards output, permission requests, tool results, and background task state over an internal protocol. Provider, model, effort, and permission mode are maintained jointly by the server and the CLI; the renderer is not the single source of truth.

`src/server/proxy/` handles the supported provider protocols:

- Anthropic Messages
- OpenAI Chat Completions
- OpenAI Responses

Model mapping, authentication style, and context settings follow the actual provider configuration. Do not hardcode a vendor list in architecture docs.

## IM adapters

Each platform runs its own adapter sidecar, so one platform's bad credentials or failed startup cannot take the others down.

```text
IM platform
  → adapters/<platform>
  → adapters/common WebSocket bridge
  → server sidecar
  → CLI session
```

The shared layer in `adapters/common/` handles configuration, pairing, session mapping, message buffering, deduplication, attachments, and the server WebSocket bridge. Current platform directories:

- `adapters/telegram/`
- `adapters/feishu/`
- `adapters/wechat/`
- `adapters/dingtalk/`
- `adapters/whatsapp/`

## Persistence boundaries

Different data does not share one store:

| Data | Primary boundary |
|---|---|
| Renderer UI preferences and open tabs | Browser storage and its migrations |
| Sessions and messages | Local session data managed by the server and CLI |
| Provider, H5, Computer Use, and other settings | Config files managed by the server |
| Electron window and native state | Electron user data / app mode directory |
| IM configuration and pairing state | Adapter config and per-platform state directories |

Any change to a JSON shape, a `localStorage` key, or the app config layout needs a forward migration plus a regression test against old data. Never overwrite the user's shared Claude configuration, and never read the real user directory from tests.

## Build and verification

Desktop builds are orchestrated by scripts in `desktop/package.json`:

```bash
cd desktop
bun run build:sidecars
bun run build
bun run build:electron
```

`electron:package` runs electron-builder on top of that. Verifying a packaged artifact only proves the asset and installer structure is correct. User flows that touch windows, permissions, terminals, preview, updates, or Computer Use still need a real desktop smoke test.
