---
title: Desktop local development and debugging
nav_title: Local dev and debugging
description: Run the desktop client from a fresh clone, the gotchas we hit, and how to use the Chrome DevTools Protocol to see the renderer's real errors.
order: 10
---

# Desktop local development and debugging

This page is for people who want to boot the desktop client in dev mode on their own machine. For architecture see [Desktop architecture](./desktop.md); this page only covers getting it running and debugging.

## Prerequisites

| Tool | Version | Purpose |
| --- | --- | --- |
| Bun | ≥ 1.3.11 (matches `package.json#packageManager`) | package management, Sidecar compile, Vite |
| Node.js | any LTS | only used for DevTools Protocol debugging |
| Visual Studio Build Tools | 2019 or 2022 | only needed for `bun run electron:package`; pure dev does not need it |
| Rust toolchain | — | **not needed**. The Sidecar is a `bun --compile` artifact, not a Rust binary |

CPU must support AVX2 (basically anything shipped after 2014). The Sidecar's default Windows x64 target is `bun-windows-x64-baseline`; this repo currently overrides it to the non-baseline variant (see "Pitfall 2" below).

## First-time boot

Run the steps in this order; a wrong order produces "window created but `visible=False`" or "sidecar binary not found".

```powershell
# 1. Install desktop dependencies (~787 packages, ~2 min)
cd D:\srcs\cchaha\cc-haha\desktop
bun install

# 2. If Electron's postinstall did not run, download the binary manually
node node_modules\electron\install.js

# 3. Install IM-adapter dependencies (the Sidecar compile pulls from adapters/, see Pitfall 1)
cd ..\adapters
bun install
cd ..\desktop

# 4. Build the Sidecar (132 MB single-file Bun executable)
bun run build:sidecars

# 5. Start Vite first (port 1420) — it must be up before Electron.
#    In terminal A:
node node_modules\vite\bin\vite.js --port 1420 --strictPort

# 6. After Vite is listening, start Electron (so the window can reveal cleanly).
#    In terminal B:
$env:ELECTRON_RENDERER_URL = "http://localhost:1420"
$env:NO_PROXY = "localhost,127.0.0.1,::1"
.\node_modules\electron\dist\electron.exe .\electron-dist\main.cjs --dev
```

The order matters. Running `bun run electron:dev` directly tends to either kill the Electron child when PowerShell exits, or have Electron try `loadURL` before Vite is listening. Splitting them is more reliable.

### Driving the renderer through the DevTools Protocol

Add two flags to the Electron command:

```powershell
.\node_modules\electron\dist\electron.exe `
  .\electron-dist\main.cjs `
  --dev `
  --remote-debugging-port=9222 `
  --remote-allow-origins=*
```

Hit `http://127.0.0.1:9222/json` to get the page's WebSocket URL, then `ws`-connect and `Runtime.evaluate`:

```js
const ws = new WebSocket(page.webSocketDebuggerUrl)
ws.send(JSON.stringify({
  id: 1,
  method: 'Runtime.evaluate',
  params: {
    expression: `
      fetch('http://127.0.0.1:51738/api/sessions', {
        headers: { 'Authorization': 'Bearer ' + await window.desktopHost.runtime.getLocalAccessToken() }
      }).then(r => r.status + ': ' + (await r.text()).slice(0, 80))
    `,
    awaitPromise: true,
    returnByValue: true,
  },
}))
```

Adding `Network.enable` lets you see whether a fetch is being killed by a CORS preflight — much faster than fishing through the browser DevTools.

## Known pitfalls and fixes

### Pitfall 1: Sidecar build fails with "Could not resolve: @whiskeysockets/baileys"

**Symptom**:

```
error: Could not resolve: "@whiskeysockets/baileys". Maybe you need to "bun install"?
error: Could not resolve: "dingtalk-stream"
error: Could not resolve: "grammy"
error: Could not resolve: "@larksuiteoapi/node-sdk"
```

**Cause**: `desktop/sidecars/claude-sidecar.ts` statically imports `adapters/{feishu,telegram,wechat,dingtalk,whatsapp}/index.ts` at the top of the file. Bun's bundler resolves these modules before DCE runs. Those modules declare dependencies (`baileys`, `dingtalk-stream`, `grammy`, `@larksuiteoapi/node-sdk`) in `adapters/package.json`, but the desktop-side compile only sees `desktop/node_modules`.

**Fix**: `bun install` in `adapters/` before building the Sidecar.

### Pitfall 2: Sidecar build hangs on the baseline runtime download

**Symptom**:

```
error: Failed to extract executable for 'bun-windows-x64-baseline-v1.3.11'.
The download may be incomplete.
```

**Cause**: `Bun.build({ compile: { target: 'bun-windows-x64-baseline' } })` downloads the baseline variant of Bun from GitHub releases and embeds it in the output. On some machines the extract step keeps failing.

**Fix (temporary)**: `desktop/scripts/build-sidecars.ts:174` — replace `bun-windows-x64-baseline` with `bun-windows-x64`. Trade-off: the Sidecar then requires AVX2.

```ts
case 'x86_64-pc-windows-msvc':
  // Prefer baseline on Windows x64 so older CPUs do not crash before the
  // desktop app can even start the local sidecar process.
  // Local override (Mavis 2026-09-05): use the non-baseline variant because
  // the baseline zip download/extract is failing on this machine; the
  // running CPU supports AVX2 so the regular binary is safe.
  return 'bun-windows-x64'
```

Revert this override if you ship the desktop app to a CPU without AVX2.

### Pitfall 3: CORS preflight blocked, every API call ends in "Failed to fetch"

**Symptom**: The Sidecar is up; `GET /health` returns 200 from PowerShell. In the renderer every `/api/*` call throws `TypeError: Failed to fetch`. DevTools Network panel shows `OPTIONS /api/xxx` returning 403.

**Cause**: `desktop/electron/main.ts:711` wires `shouldAuthorize = isAllowlistedMainRendererMediaRequest`, so `configureLocalServerRequestAuth` only attaches the bearer token for a media allowlist (`/api/desktop-ui/preferences/profile/avatar`, `/api/filesystem/file`, `/api/open-targets/icons/`, `/preview-fs/`). But browser-issued CORS preflights (OPTIONS) **cannot carry Authorization** — that's a browser spec rule. So every preflight to `/api/*` reaches the Sidecar without a token and gets dropped by `shouldBlockDisabledH5Access` (H5 disabled + cross-origin origin → 403).

The Sidecar side (`src/server/index.ts:340-342` + `src/server/h5AccessPolicy.ts:292-314`):

```ts
// As soon as sidecar env has CC_HAHA_LOCAL_ACCESS_TOKEN (Electron injects one),
// any request with an Origin but no valid Bearer is classified as h5-browser.
// H5 disabled + h5-browser + /api/*  → 403.
```

**Fix**: `desktop/electron/main.ts:711` — change `shouldAuthorize` to `() => true` so every request destined for the local Sidecar URL gets the Authorization header, including preflights.

```ts
configureLocalServerRequestAuth(
  mainWindow.webContents.session.webRequest,
  resolveMainRendererServerAccess,
  // Local override (Mavis 2026-09-05): always authorize the local sidecar URL,
  // not only the media allowlist. The renderer also attaches the bearer on its
  // own fetch calls, but browser-issued CORS preflights (OPTIONS) cannot carry
  // Authorization, so without this the sidecar's H5-disabled gate rejects the
  // preflight with 403 and every cross-origin API call dies with "Failed to
  // fetch". The media allowlist is preserved separately below.
  () => true,
)
```

> This is a real bug — open a PR upstream rather than keeping the override long-term.

### Pitfall 4: Window created but visible=False

**Symptom**: Process is running, `MainWindowHandle` is non-zero, but `IsWindowVisible = False`. Calling `ShowWindow` from outside does not help — Electron owns the paint state.

**Cause**: `BrowserWindow` is created with `show: false` and only revealed after the renderer paints. If Sidecar or Vite are not ready by then, `loadAndRevealMainWindow` may walk the onLoadFailure branch and leave the window in `show: false`.

**Fix**: Make sure Vite is listening on 1420 before Electron starts. Use `--remote-debugging-port=9222` and inspect `Network.enable` traces to confirm the renderer can reach the Sidecar.

### Pitfall 5: Adapter sidecars exit immediately because there are no credentials

**Symptom**: Five lines like this in the log:

```
[claude-sidecar] no adapter could be started — check credentials in env or ~/.claude/adapters.json
```

**Cause**: Electron spawns one `claude-sidecar adapters --feishu --app-root ...` subprocess per IM platform. If `~/.claude/adapters.json` or the environment does not have credentials, the adapter module's top-level guard calls `process.exit(1)` immediately.

**What to do**: Ignore. Configure IM credentials and the messages disappear.

## Debugging cheat sheet

| Symptom | First check |
| --- | --- |
| "Electron sidecar binary not found" | run `bun run build:sidecars` |
| "Failed to fetch" + OPTIONS 403 in DevTools | Pitfall 3 |
| Window renders the "local service failed to start" card | copy the server logs from the diagnostic block; check why `/health` failed |
| Renderer cannot reach `getServerUrl` IPC | verify Sidecar is alive: `Get-NetTCPConnection -LocalPort 51738 -State Listen` |
| Vite stuck on "Re-optimizing dependencies" | delete `node_modules/.vite` and restart |
| `bun run build:sidecars` repeatedly fails on baseline | Pitfall 2 |

## See also

- [Desktop architecture](./desktop.md)
- [Contributing](./contributing.md)
- Repository root `AGENTS.md` → "Verification" section — `bun run check:desktop-ui-smoke` is the real end-to-end lane driven through a real browser against the mock runtime
