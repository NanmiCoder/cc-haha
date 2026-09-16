---
title: 桌面端本地开发与调试
nav_title: 本地开发调试
description: 从零在本地把桌面端跑起来，踩过的坑、临时改的点、以及怎么用 DevTools 协议看渲染端真实错误。
order: 10
---

# 桌面端本地开发与调试

这篇是给想在本地以 dev 模式跑起桌面端的人。架构层看 [桌面端架构](./desktop.md)，本篇只讲怎么把它跑起来、怎么排查 bug。

## 前置依赖

| 工具 | 版本 | 用途 |
| --- | --- | --- |
| Bun | ≥ 1.3.11（与 `package.json#packageManager` 一致） | 包管理、Sidecar 编译、Vite 启动 |
| Node.js | 任意 LTS | 仅用于 DevTools 协议调试 |
| Visual Studio Build Tools | 2019 或 2022 | 仅打包（`bun run electron:package`）时需要；纯 dev 不需要 |
| Rust 工具链 | — | **不需要**。Sidecar 是 Bun `--compile` 产物，不用 Rust |

CPU 必须支持 AVX2（2014 年后基本都满足）。Sidecar 在 Windows x64 上默认走 `bun-windows-x64-baseline`，本仓库已临时改成非 baseline 变体（见下文"坑 2"）。

## 第一次启动

按顺序执行；顺序错了会出现"窗口创建但 visible=False"或"sidecar binary not found"。

```powershell
# 1. 装桌面端依赖（约 787 个包，2 分钟左右）
cd D:\srcs\cchaha\cc-haha\desktop
bun install

# 2. 如果上一步没自动跑 Electron postinstall，手动下载二进制
node node_modules\electron\install.js

# 3. 装 IM 适配器依赖（Sidecar 编译需要用到 adapters/，见坑 1）
cd ..\adapters
bun install
cd ..\desktop

# 4. 编译 Sidecar（生成 132 MB 的单文件 Bun 可执行文件）
bun run build:sidecars

# 5. 先起 Vite（端口 1420）—— 必须先于 Electron
#    在终端 A：
node node_modules\vite\bin\vite.js --port 1420 --strictPort

# 6. 等 Vite 起来后再起 Electron（窗口才能正常 reveal）
#    在终端 B：
$env:ELECTRON_RENDERER_URL = "http://localhost:1420"
$env:NO_PROXY = "localhost,127.0.0.1,::1"
.\node_modules\electron\dist\electron.exe .\electron-dist\main.cjs --dev
```

启动顺序是关键。直接跑 `bun run electron:dev` 经常会出现"Bun 脚本里 Electron 进程随 PowerShell 退出而消失"或"Vite 还没监听、Electron 就开始 loadURL"的问题。手动分开跑更可控。

### 用 DevTools 协议看渲染端错误

启动 Electron 时加两个 flag：

```powershell
.\node_modules\electron\dist\electron.exe `
  .\electron-dist\main.cjs `
  --dev `
  --remote-debugging-port=9222 `
  --remote-allow-origins=*
```

然后通过 HTTP `/json` 拿到 page 的 WebSocket URL，用 `ws` 连上去 `Runtime.evaluate` 跑 JS：

```js
// 通过 pageId 的 webSocketDebuggerUrl 连进去
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

挂上 `Network.enable` 还能看到所有 fetch 是不是被 CORS preflight 拦了。这比在浏览器开发者工具里瞎试快得多。

## 已知坑与修复

### 坑 1：编译 Sidecar 时找不到 IM 适配器依赖

**症状**：

```
error: Could not resolve: "@whiskeysockets/baileys". Maybe you need to "bun install"?
error: Could not resolve: "dingtalk-stream"
error: Could not resolve: "grammy"
error: Could not resolve: "@larksuiteoapi/node-sdk"
```

**原因**：`desktop/sidecars/claude-sidecar.ts` 顶层静态 import 了 `adapters/{feishu,telegram,wechat,dingtalk,whatsapp}/index.ts`，bun build 在 DCE 前要 resolve 这些模块的依赖。这些依赖（`baileys`、`dingtalk-stream`、`grammy`、`larksuiteoapi/node-sdk`）只声明在 `adapters/package.json`，但桌面端编译时只看到 `desktop/node_modules`。

**修复**：先在 `adapters/` 下 `bun install` 再编译 Sidecar。

### 坑 2：Sidecar 构建卡在 baseline 二进制下载

**症状**：

```
error: Failed to extract executable for 'bun-windows-x64-baseline-v1.3.11'.
The download may be incomplete.
```

**原因**：`Bun.build({ compile: { target: 'bun-windows-x64-baseline' } })` 要从 GitHub releases 下载 baseline 变体的 zip 再嵌入输出。在某些机器上解压步骤一直失败。

**修复（临时）**：`desktop/scripts/build-sidecars.ts:174` 把 `bun-windows-x64-baseline` 改成 `bun-windows-x64`。代价是 Sidecar 二进制要求 CPU 支持 AVX2。

```ts
case 'x86_64-pc-windows-msvc':
  // Prefer baseline on Windows x64 so older CPUs do not crash before the
  // desktop app can even start the local sidecar process.
  // Local override (Mavis 2026-09-05): use the non-baseline variant because
  // the baseline zip download/extract is failing on this machine; the
  // running CPU supports AVX2 so the regular binary is safe.
  return 'bun-windows-x64'
```

要发布给不支持 AVX2 的旧 CPU 时回退此改动。

### 坑 3：CORS preflight 失败导致所有 API 调用 "Failed to fetch"

**症状**：Sidecar 已经起来，`GET /health` 在 PowerShell 里返回 200，但渲染端日志里所有 `/api/*` 请求都报 `TypeError: Failed to fetch`。DevTools Network 面板里能看到 `OPTIONS /api/xxx` 返回 403。

**原因**：`desktop/electron/main.ts:711` 的 `configureLocalServerRequestAuth` 用 `shouldAuthorize = isAllowlistedMainRendererMediaRequest`，**只对媒体白名单**（`/api/desktop-ui/preferences/profile/avatar`、`/api/filesystem/file`、`/api/open-targets/icons/`、`/preview-fs/`）加 Authorization header。但浏览器 CORS preflight（OPTIONS）**无法携带 Authorization**——这是浏览器规范。所以发往 `/api/*` 的 preflight 永远没 token，被 sidecar 的 `shouldBlockDisabledH5Access` 在 H5-disabled + 跨源 origin 场景下拦截，返回 403。

sidecar 端的具体逻辑（`src/server/index.ts:340-342` + `src/server/h5AccessPolicy.ts:292-314`）：

```ts
// 只要 sidecar env 里配了 CC_HAHA_LOCAL_ACCESS_TOKEN（即 Electron 已注入），
// 任何带 Origin 但不带正确 Bearer 的请求都会被归类为 h5-browser。
// H5 disabled + h5-browser + /api/* → 403。
```

**修复**：`desktop/electron/main.ts:711` 把 `shouldAuthorize` 改成 `() => true`，对所有发往本地 sidecar URL 的请求都加 Authorization。preflight 也能带 token 通过认证。

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

> 这是一个真 bug，应该作为 PR 修回上游，不应该长期留 override。

### 坑 4：窗口创建了但 visible=False

**症状**：进程在跑、`MainWindowHandle` 非 0，但 `IsWindowVisible = False`。Electron 主进程的 `window.show()` 被外部 `ShowWindow` 调用无法覆盖——Electron 自己维护 paint 状态。

**原因**：Electron 启动时 `BrowserWindow` 用 `show: false` 创建，等渲染端 first paint 后才调 `mainWindow.show()`。如果 first paint 之前 sidecar/vite 还没准备好、`loadAndRevealMainWindow` 走到 onLoadFailure 分支，可能窗口就被遗留在 `show: false` 状态。

**修复**：Vite 必须先监听 1420，Electron 再起。让 `--remote-debugging-port=9222` 跑起来后通过 DevTools `Network.enable` 看渲染端请求是不是正常 200。

### 坑 5：adapter sidecar 因为没凭据秒退

**症状**：日志里看到五条

```
[claude-sidecar] no adapter could be started — check credentials in env or ~/.claude/adapters.json
```

**原因**：Electron 会为每个 IM 适配器 spawn 一个 `claude-sidecar adapters --feishu --app-root ...` 子进程。如果 `~/.claude/adapters.json` 或环境变量里没有对应凭据，适配器顶层直接 `process.exit(1)`。

**应对**：忽略即可，等你配了 IM 凭据就不会再刷这几行。

## 调试速查

| 现象 | 第一步 |
| --- | --- |
| "Electron sidecar binary not found" | `bun run build:sidecars` 跑一下 |
| "Failed to fetch" + DevTools 看 OPTIONS 403 | 见坑 3 |
| 窗口显示但 UI 是"本地服务启动失败"卡死 | 复制诊断信息里的 server logs，看是不是 health check 失败 |
| 渲染端拿不到 server URL（IPC 抛错） | 看 sidecar 是否真起来了，`Get-NetTCPConnection -LocalPort 51738 -State Listen` |
| Vite 报 "Re-optimizing dependencies" 卡住 | 删 `node_modules/.vite` 重启 |
| `bun run build:sidecars` 一直报 baseline 失败 | 见坑 2 |

## 下一步要看的

- [桌面端架构](./desktop.md)
- [贡献流程](./contributing.md)
- 仓库根 `AGENTS.md` 里的 "Verification" 节——`bun run check:desktop-ui-smoke` 是真正用 `agent-browser` 驱动真实 UI 的端到端 lane
