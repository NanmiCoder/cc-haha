# Web 端落地计划

> **目标读者**：负责把 cc-haha 桌面端复刻为浏览器端工作台的开发者。
> **范围边界**：本机 / 局域网 dev 部署；不涉及用户认证、多用户、生产部署、PTY、Adapter sidecar、自动更新、原生文件对话框。
> **本文件**：定稿设计文档。实施步骤拆分见 §6；后续 implementation plan 由 `superpowers:writing-plans` 单独输出。

## 1. 背景与决策

### 1.1 现状摘要

cc-haha 已存在「H5 远程访问」模式（参见 `desktop/src/lib/desktopRuntime.ts` 中 `isBrowserH5Runtime()` / `H5ConnectionRequiredError` / `initializeBrowserServerUrl` 等），同时：

- `src/server/staticH5.ts` 已能伺服 `desktop/dist/` 静态文件。
- `src/server/h5AccessPolicy.ts` 已对 loopback / 跨主机请求做分类，并把 `/sdk/*` 严格限定为 internal。
- `desktop/src/` **不导入** `src/`、不使用 `node:fs` / `Bun.spawn` / `os.homedir`，所有外部访问只走 `/api/*` REST、`/ws/<sid>` WebSocket、`@tauri-apps/*` 三个通道。

「Web 端」其实是把这条 H5 通道从「远程入口」升级为「一等 build target」。

### 1.2 关键决策（已确认）

1. **目录组织**：路线 A —— 不新建 `web/` 包，不改名 `desktop/`，单源码双 target（`desktop/` 既出 desktop 也出 web）。
2. **屏蔽功能**（web target 下不可用）：
   - PTY 终端
   - Adapter sidecar 热重启
   - 自动更新
   - 原生文件 / 目录选择对话框
3. **Workspaces**：仓库根新建 `workspaces/`，每会话以 `workspaces/<sessionId>/` 为 cwd；由 server 在创建会话时自动 mkdir；**永不自动清理**。
4. **不支持选择本地仓库 / 本地路径**。
5. **系统通知**：使用浏览器 Web Notification API。
6. **不引入用户认证 / 多用户**。
7. **运行时 gate 为主**，UI 入口在 web 模式下隐藏；非 Tauri 环境下所有 `@tauri-apps/*` 调用走 `tauriBridge` 抛 `TauriUnavailableError` 或安全 fallback。

### 1.3 不在本计划范围

- 用户认证、多用户、会话隔离、ACL
- 生产部署（Docker、systemd、TLS、反代、CSP 收紧）
- PTY / Adapter / 自动更新 在 web 下的替代实现
- Bundle 体积优化（lazy load xterm / mermaid / shiki 等）
- E2E 默认接入 `bun run verify`（首次落地仅作为独立 lane）

## 2. 架构

### 2.1 进程模型

```
浏览器
  │  HTTP /api/*  +  WS /ws/<sid>
  ▼
Bun server (单进程, 端口 3456)
  │  spawn 每会话一个
  ▼
CLI subprocess
  cwd = workspaces/<sessionId>
```

无 Tauri 主进程、无 Adapter sidecar、无 PTY、无自更新。`/sdk/<sid>` 仍由 CLI 子进程在本机回连（loopback），不暴露给浏览器。

### 2.2 顶层目录变化

```
cc-haha/
├── workspaces/                          ← 新增
│   ├── .gitignore                       ← 忽略所有子目录但保留 README
│   └── README.md
├── src/server/
│   ├── config/
│   │   └── runtimeMode.ts               ← 新增
│   ├── services/
│   │   ├── webWorkspaceService.ts       ← 新增
│   │   ├── sessionService.ts            ← 改：web 模式自动建 workspace
│   │   └── repositoryLaunchService.ts   ← 改：web 模式 fail-fast 拒绝 git launch
│   └── index.ts                         ← 改：可选 SERVER_HOST env
├── desktop/
│   ├── src/
│   │   ├── lib/
│   │   │   ├── desktopRuntime.ts        ← 改：导出 isWebTarget()
│   │   │   ├── desktopNotifications.ts  ← 改：增加 web 分支
│   │   │   └── tauriBridge.ts           ← 新增：所有 @tauri-apps/* 动态 import 集中点
│   │   ├── api/client.ts                ← 改：DEFAULT_BASE_URL 在 web 下取 location.origin
│   │   ├── components/...               ← 19 处静态 import 改造为 tauriBridge
│   │   └── pages/...                    ← UI gate
│   ├── vite.config.ts                   ← 改：BUILD_TARGET=web 分支
│   ├── package.json                     ← 改：build:web / build:web:watch
│   └── dist-web/                        ← web build 产物（gitignored）
├── docs/web/web-deployment-plan.md      ← 本文档
└── package.json                         ← 改：start:web
```

### 2.3 运行时 gate 总图

```
                     ┌─ desktop (Tauri webview)  : isTauriRuntime() = true,  isWebTarget() = false
isWebTarget() ──────┤
                     └─ web (浏览器, 同源/局域网) : isTauriRuntime() = false, isWebTarget() = true
```

`tauriBridge.ts` 是唯一允许接触 `@tauri-apps/*` 的文件；其余 18 处静态 import 全部改为通过它的导出函数访问。

## 3. 服务端改动

### 3.1 运行时模式探测

新增 `src/server/config/runtimeMode.ts`：

```ts
export type RuntimeMode = 'desktop' | 'web'

let cached: RuntimeMode | null = null

export function detectRuntimeMode(): RuntimeMode {
  if (cached) return cached
  if (process.env.CC_HAHA_RUNTIME === 'web') return (cached = 'web')
  if (process.env.CC_HAHA_RUNTIME === 'desktop') return (cached = 'desktop')
  // 缺省：Tauri sidecar 启动时会传 CLAUDE_APP_ROOT
  cached = process.env.CLAUDE_APP_ROOT ? 'desktop' : 'web'
  return cached
}

export function getRuntimeMode(): RuntimeMode {
  return cached ?? detectRuntimeMode()
}
```

由 `src/server/index.ts` 启动早期调用一次；其余 services 通过 `getRuntimeMode()` 读取。

### 3.2 Web workspace 服务

新增 `src/server/services/webWorkspaceService.ts`：

```ts
import path from 'node:path'
import fs from 'node:fs/promises'

const WORKSPACES_ROOT = path.resolve(process.cwd(), 'workspaces')

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/

export async function ensureWebWorkspace(sessionId: string): Promise<string> {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(`Invalid sessionId for web workspace: ${sessionId}`)
  }
  const dir = path.join(WORKSPACES_ROOT, sessionId)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

export function getWebWorkspaceRoot(): string {
  return WORKSPACES_ROOT
}
```

约束：
- 仅暴露这两个函数。
- `SESSION_ID_RE` 防 path traversal（拒绝 `..`、绝对路径、URL 转义符）。
- **永不自动清理**。删除会话时是否清理 `workspaces/<sid>/` 列入「待定」，本计划默认不清理。

### 3.3 sessionService / repositoryLaunchService 改动

- `sessionService.createSession(...)`：当 `getRuntimeMode() === 'web'` 且未指定 `workDir` 时，先 `await ensureWebWorkspace(sessionId)` 拿到 cwd，再写入 `SessionLaunchInfo.workDir`。后续流转（`conversationService.startSession` → `buildSessionCliArgs` → 子进程 `CALLER_DIR`/`PWD` 显式覆盖）已存在，无需改。这条不变量在 CLAUDE.md 已记录，不再重复。
- `repositoryLaunchService.prepareSessionWorkspace(...)`：当 `getRuntimeMode() === 'web'` 收到 git 仓库类启动请求时，**fail-fast** 抛错「web 模式不支持选择本地仓库，请使用默认 workspace」。

### 3.4 SERVER_HOST 支持

需要确认 `src/server/index.ts` 是否已读取 `SERVER_HOST` env；如未支持，本计划在 commit 1 中补齐：

```ts
const port = Number(process.env.SERVER_PORT) || 3456
const hostname = process.env.SERVER_HOST || '127.0.0.1'
Bun.serve({ port, hostname, fetch, websocket })
```

`hostname='0.0.0.0'` 用于局域网试用。

### 3.5 H5 鉴权 / CORS

沿用 `h5AccessPolicy.ts` 现有逻辑，不修改：
- 同源 / loopback：`local-trusted` 直接放行。
- 跨主机：`h5-browser` 触发 H5 token 流程（首次需用户从 server 控制台手动拷贝 token）。
- `/sdk/*` 仅 `internal-sdk` 放行，浏览器永远拿不到。

CSP 不在本计划新增。

## 4. 前端改动

### 4.1 `lib/tauriBridge.ts`（新增）

集中所有 `@tauri-apps/*` 动态 import：

```ts
import { isTauriRuntime } from './desktopRuntime'

export class TauriUnavailableError extends Error {
  constructor(public capability: string) {
    super(`Tauri capability "${capability}" is unavailable in this runtime.`)
    this.name = 'TauriUnavailableError'
  }
}

export async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) throw new TauriUnavailableError(`invoke:${cmd}`)
  // @ts-expect-error optional dep
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

export async function tauriListen(event: string, handler: (e: unknown) => void) {
  if (!isTauriRuntime()) return () => {}
  // @ts-expect-error optional dep
  const { listen } = await import('@tauri-apps/api/event')
  return listen(event, handler)
}

export async function tauriShellOpen(url: string) {
  if (!isTauriRuntime()) {
    window.open(url, '_blank', 'noopener')
    return
  }
  // @ts-expect-error optional dep
  const { open } = await import('@tauri-apps/plugin-shell')
  return open(url)
}

export async function tauriDialogOpen(opts: unknown): Promise<string | null> {
  if (!isTauriRuntime()) return null
  // @ts-expect-error optional dep
  const { open } = await import('@tauri-apps/plugin-dialog')
  return (await open(opts as never)) as string | null
}

// 同样模式：tauriGetCurrentWindow / tauriRequestUserAttention /
// tauriUpdaterCheck / tauriUpdaterDownloadAndInstall /
// tauriProcessRelaunch / tauriNotificationPermission /
// tauriNotificationSend / tauriAppGetMetadata
```

### 4.2 `lib/desktopRuntime.ts` 扩展

```ts
export function isWebTarget(): boolean {
  // 构建期注入 + 运行期兜底
  return (
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_BUILD_TARGET === 'web') ||
    !isTauriRuntime()
  )
}
```

### 4.3 `api/client.ts` 默认 baseUrl

```ts
const DEFAULT_BASE_URL = ENV_BASE_URL
  || (typeof window !== 'undefined' && import.meta.env.VITE_BUILD_TARGET === 'web'
      ? window.location.origin.replace(/\/$/, '')
      : 'http://127.0.0.1:3456')
```

`ENV_BASE_URL`（`VITE_DESKTOP_SERVER_URL`）显式优先；其次 web target 下走 `location.origin`；desktop fallback 仍是 `127.0.0.1:3456`。

### 4.4 `@tauri-apps/*` 引用处理清单

涉及 `@tauri-apps/*` 引用的 19 处中，1 处已动态 import 保持不变，其余 18 处全部改造为通过 `tauriBridge` 调用：

| 文件 | 改造 |
|---|---|
| `lib/desktopRuntime.ts:119` | 已动态 import，保持不变 |
| `lib/desktopNotifications.ts` | 改用 `tauriBridge`；增加 web 分支：首次 `Notification.requestPermission()`，之后 `new Notification(title, { body, icon })`；权限被拒时静默降级为 toast |
| `api/terminal.ts` | 已 `isTauriRuntime()` 守卫；web target 下函数本身抛 `TauriUnavailableError`，调用方需自行处理（实际通过 UI gate 不会触发） |
| `stores/adapterStore.ts:18` | 改 `tauriInvoke`；web 下捕获 `TauriUnavailableError` 后置 `{ supported: false, message }` |
| `stores/updateStore.ts` | 改 `tauriBridge`；web 下置 `available=false`、`relaunch()` noop |
| `components/layout/AppShell.tsx` | `event.listen` → `tauriListen`，web 下 noop |
| `components/layout/{TitleBar, WindowControls, TabBar, Sidebar}.tsx` | `getCurrentWindow` 等改 `tauriBridge`；web 下短路不渲染窗口控件 |
| `components/settings/ClaudeOfficialLogin.tsx:8` | 静态 `plugin-shell.open` → `tauriShellOpen`（web 下走 `window.open`） |
| `components/shared/DirectoryPicker.tsx` | `plugin-dialog.open` → `tauriDialogOpen`；web 下 disabled + 文案「在浏览器中不可选择本地路径」 |
| `pages/ComputerUseSettings.tsx` | 同上 dialog/shell |
| `pages/Settings.tsx`（外链 / OAuth / dialog） | 同上 |
| `pages/TerminalSettings.tsx` | terminal_* 命令保留；整页面通过 ContentRouter gate 在 web 下不渲染 |
| `pages/Settings.tsx:2728`（`@tauri-apps/api/app`） | 改 `tauriBridge.tauriAppGetMetadata()`；web 下用 `import.meta.env` 兜底 |

### 4.5 UI gate 总览

- **`components/layout/ContentRouter.tsx`**：`isWebTarget()` 时不再分派 `<TerminalSettings>`；Terminal tab 类型在 `tabStore` 创建时拒绝。
- **`components/layout/{Sidebar, TitleBar, WindowControls}.tsx`**：web 下隐藏窗口控制按钮。
- **`pages/Settings.tsx`**：web 下隐藏 Terminal Settings 块、Updater 块、Adapter restart 按钮；显示「以下功能仅在桌面应用中可用」提示卡。
- **新建会话弹窗**：web 下隐藏「选择本地仓库 / Worktree 启动」分支，仅留「使用默认 workspace」按钮。

### 4.6 浏览器通知

`lib/desktopNotifications.ts` 新增 web 分支：

```ts
async function ensureBrowserPermission(): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined') return 'denied'
  if (Notification.permission === 'default') {
    return Notification.requestPermission()
  }
  return Notification.permission
}

async function sendBrowserNotification(title: string, body: string) {
  const permission = await ensureBrowserPermission()
  if (permission !== 'granted') return false
  // eslint-disable-next-line no-new
  new Notification(title, { body })
  return true
}
```

入口（`useScheduledTaskDesktopNotifications` / 权限请求未审批提醒 / 会话完成等）保持原 API 不变；内部按 `isWebTarget()` 走 web 分支或 Tauri 分支。

### 4.7 WebSocket 协议推导

`buildSessionWebSocketUrl` 沿用现有实现：从 `getBaseUrl()` 推导，`http→ws / https→wss`。web target 下 `getBaseUrl()` 已等于 `window.location.origin`，因此自动同源。

## 5. 构建与运行脚本

### 5.1 `desktop/vite.config.ts`

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

const target = process.env.BUILD_TARGET === 'web' ? 'web' : 'desktop'
const isWeb = target === 'web'
const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    'import.meta.env.VITE_BUILD_TARGET': JSON.stringify(target),
  },
  build: {
    outDir: isWeb ? 'dist-web' : 'dist',
    chunkSizeWarningLimit: 2200,
    rollupOptions: {
      onwarn(warning, warn) {
        if (warning.code === 'INEFFECTIVE_DYNAMIC_IMPORT') return
        warn(warning)
      },
    },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
})
```

### 5.2 脚本

`desktop/package.json`：

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "build:web": "tsc -b && BUILD_TARGET=web vite build",
    "build:web:watch": "BUILD_TARGET=web vite build --watch"
  }
}
```

> Windows PowerShell 用户改用 `$env:BUILD_TARGET='web'; vite build`，或安装 `cross-env`。bun 自带的跨平台 env 语法支持 `BUILD_TARGET=web bun run vite` 写法。

根 `package.json`：

```json
{
  "scripts": {
    "start:web": "CC_HAHA_RUNTIME=web CLAUDE_H5_DIST_DIR=./desktop/dist-web bun run src/server/index.ts"
  }
}
```

`CLAUDE_H5_DIST_DIR` 已被 `staticH5.ts` 支持，无需改 server。

### 5.3 典型工作流

| 场景 | 命令 |
|---|---|
| Web 开发（同源 + 自动重建） | 终端 1：`cd desktop && bun run build:web:watch`<br>终端 2：`bun run start:web`<br>浏览器：`http://127.0.0.1:3456`，前端改动后手动刷新 |
| 一次性构建 + 运行 | `cd desktop && bun run build:web`<br>`bun run start:web`<br>浏览器：`http://127.0.0.1:3456` |
| 局域网试用 | 上面 build 后，`SERVER_HOST=0.0.0.0 bun run start:web`<br>手机浏览器：`http://<lan-ip>:3456`（首次需 H5 token） |
| Desktop（不变） | `cd desktop && bun run tauri dev` |

### 5.4 `workspaces/` 文件

`workspaces/.gitignore`：

```
*
!.gitignore
!README.md
```

`workspaces/README.md`：简短说明用途、自动 mkdir 规则、永不自动清理、git 已忽略子目录。

## 6. 实施步骤

按以下 6 个 commit 顺序落地，每步独立可验证：

| # | Commit | 内容 | 验证 |
|---|---|---|---|
| 1 | `feat(server): add runtime mode + web workspace service` | `config/runtimeMode.ts`、`services/webWorkspaceService.ts`、`sessionService` / `repositoryLaunchService` web 分支、`workspaces/.gitignore` + `README.md`、`SERVER_HOST` env 支持（如未支持） | `bun test` server；手工 `CC_HAHA_RUNTIME=web bun run src/server/index.ts` 启动；POST 创建会话后 `workspaces/<sid>/` 出现 |
| 2 | `feat(desktop): add tauriBridge + isWebTarget + DEFAULT_BASE_URL fix` | `lib/tauriBridge.ts`、扩展 `desktopRuntime.ts:isWebTarget()`、修 `api/client.ts` 默认 baseUrl；同区域 test | desktop test；`vite build`（无 BUILD_TARGET）通过 |
| 3 | `refactor(desktop): convert static @tauri-apps imports to tauriBridge` | 19 处静态 import 全部改为 `tauriBridge`；`desktopNotifications.ts` web 分支；`adapterStore` / `updateStore` 优雅降级 | desktop test；`tauri dev` 仍正常；非 Tauri 浏览器加载现有 dist 不抛错 |
| 4 | `feat(desktop): add web build target (vite + scripts)` | `vite.config.ts` 加 `BUILD_TARGET=web` 分支与 `define`；`desktop/package.json` 新增 `build:web` / `build:web:watch`；根 `package.json` 新增 `start:web` | `cd desktop && bun run build:web` 产出 `desktop/dist-web/`；`bun run start:web` 浏览器访问 `:3456` 看到 SPA |
| 5 | `feat(desktop): runtime gates for web-unsupported features` | ContentRouter 屏蔽 Terminal tab；Sidebar/TitleBar/WindowControls web 下不渲染；Settings 隐藏 Updater / Adapter restart / Terminal Settings 块；新建会话弹窗隐藏「选择本地仓库」分支；DirectoryPicker / dialog open 在 web 下禁用 + 文案 | desktop test；`start:web` 后人工巡检三页 |
| 6 | `test(web): playwright e2e + check:web-e2e lane` | `desktop/e2e/`；`check:web-e2e` 脚本；CI workflow 接入（独立 lane） | `bun run check:web-e2e` 通过 |

每个 commit 都跑 `bun run verify`；commit 5 之后人工巡检；commit 6 之后跑 E2E。

## 7. 测试策略

### 7.1 单元 / 集成测试（vitest，desktop）

| 区域 | 要点 |
|---|---|
| `lib/desktopRuntime.ts` | `isWebTarget()` 在三种情境下返回值 |
| `lib/tauriBridge.ts` | 非 Tauri 环境：`tauriInvoke` 抛错、`tauriListen` 返 noop、`tauriShellOpen` 走 `window.open`、`tauriDialogOpen` 返 null |
| `lib/desktopNotifications.ts` | web 分支 mock `Notification`，权限拒绝时降级 toast |
| `api/client.ts` | `DEFAULT_BASE_URL` 在 web / desktop / env 显式三种下取值 |
| `stores/adapterStore.ts` | web 下 `restartAdapters` 抛 `TauriUnavailableError` 后状态降级 |
| `stores/updateStore.ts` | web 下 `available=false`、`relaunch()` noop |
| `components/layout/ContentRouter.tsx` | web 下 Terminal tab fallback / 不渲染 |
| `components/shared/DirectoryPicker.tsx` | web 下 disabled + 文案；desktop 下走 dialog mock |
| `pages/Settings.tsx` 各受影响块 | web 下不在 DOM；desktop 下渲染 |
| 新建会话弹窗 | web 下隐藏「选择本地仓库」分支；提交 body 不带 workDir |

### 7.2 单元 / 集成测试（bun:test，server）

| 区域 | 要点 |
|---|---|
| `config/runtimeMode.ts` | env 显式优先；缺省按 `CLAUDE_APP_ROOT` |
| `services/webWorkspaceService.ts` | `ensureWebWorkspace` 幂等、可写、返回绝对路径；path-traversal 拒绝 |
| `services/sessionService.ts` | web + 无 workDir 时调 `ensureWebWorkspace` 并写 `SessionLaunchInfo.workDir`；desktop 不调 |
| `services/repositoryLaunchService.ts` | web 模式 git launch 请求 fail-fast |
| `index.ts` 启动 | `start:web` 启动后 `/health` 200、`staticH5` 找到 `dist-web/index.html`、`SERVER_HOST=0.0.0.0` 真的绑 0.0.0.0 |

### 7.3 E2E（Playwright，新增）

`desktop/e2e/` 下新建 Playwright 配置；`webServer` 配置为 `bun run start:web`，前端 build 在 `globalSetup` 完成；新增 `check:web-e2e` lane。

| 场景 | 期望 |
|---|---|
| Web 启动冒烟 | SPA 加载完成；console 无 Tauri 相关 error |
| 创建会话 + workspace 自动建 | `workspaces/<sid>/` 在 server 端存在；状态栏显示 cwd |
| Chat 流（mock provider） | 收到 `content_delta` / `message_complete`；token usage 显示 |
| 权限审批 | `permission_request` UI 弹出，approve 后流继续 |
| 禁用功能 UI gate | Settings 不显示 Terminal / Updater / Adapter restart |
| 浏览器通知 | mock `Notification.requestPermission='granted'` 后 `new Notification` 被调用 |
| Tauri 不存在校验 | 任何 `@tauri-apps/*` 动态 import 仅在被调用时按需 fallback，未被调用则不加载 |
| Bundle 检查 | `dist-web/` 入口 chunk 不出现 Tauri 静态引用之外的不当依赖 |

### 7.4 Quality gate 接入

- `bun run verify` 现有 lane 已覆盖 `check:server` / `check:desktop`，本次新增 unit/integration test 沿用，无需新 lane。
- E2E lane（`check:web-e2e`）单独执行，**首次落地不进 verify 默认链路**；PR 描述需附 E2E 通过 artifacts。
- Changed-line coverage 走默认门槛；任何 web target 新增执行行都需被同区域 test 覆盖。

### 7.5 PR 描述必填手工验证清单

1. `bun run verify` 通过（artifacts 路径）
2. `cd desktop && bun run build:web` 成功，bundle 大小记录
3. `bun run start:web` 启动后访问 `:3456`，截图三页：EmptySession、ActiveSession、Settings（看到 web 模式 gate）
4. 局域网手机访问 `:3456` 触发 H5 token 流程并能登录后正常聊天
5. `bun run tauri dev` 桌面模式无回归（同样三页截图）
6. E2E 测试本地通过

## 8. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| `@tauri-apps/*` 是 `optionalDependencies`，若 CI 未装这些包，动态 import 在 ts 类型检查阶段会报错 | `tsc -b` 失败 | 保留 optionalDependencies；`tauriBridge.ts` 中 import 加 `// @ts-expect-error optional dep`；vite build web target 下因为 dynamic import 包裹于 `if (isTauriRuntime())` 被 rollup 判定为可选 chunk |
| Bundle 体积（@xterm 等仅 PTY 用）仍打进 web bundle | dist-web 偏大 | 不引入 stub；靠 `chunkSizeWarningLimit` 容忍。> 5MB 时再追加 lazy import xterm，列入「已知未做」 |
| 新建会话路径在 desktop 下也被 web 分支误触 | desktop 错误地建 workspace | `runtimeMode === 'web'` 严格守卫；server test 同时覆盖两种模式 |
| `staticH5.ts` 不识别 `desktop/dist-web` | 生产模式 404 | 用 `CLAUDE_H5_DIST_DIR` env 显式指向，`start:web` 脚本预设；不动 `staticH5.ts` |
| `SERVER_HOST` 当前可能未被读取 | 局域网部署失败 | commit 1 中确认并补齐；测试覆盖 `0.0.0.0` 与 `127.0.0.1` 两种绑定 |
| H5 token 跨主机访问需用户从 server 控制台拷贝 token | 体验略糙 | 沿用现有机制；本计划不做 token UI 改造，文档明示 |
| OAuth callback 跨主机 | 需要 callback 同源 | 保持现状（callback 同 server 同源即可）；本计划不调整 OAuth |
| 前端代码体积增长导致首屏慢 | UX 退化 | 验证步骤记录 bundle 大小；列入「已知未做」由后续 lazy route 优化 |

## 9. 实施完成定义

- 6 个 commit 全部 merge 进 main。
- `bun run verify` 通过。
- `bun run check:web-e2e` 通过（独立 lane）。
- `bun run tauri dev` 桌面模式无回归。
- `bun run start:web` 本机访问 `:3456`、局域网手机访问 `<lan-ip>:3456` 均能完成「创建会话 → 发送消息 → 收到回复」全流程。
- 本文件、CLAUDE.md、AGENTS.md（如需）同步更新。

## 10. 引用

- `CLAUDE.md` —— Desktop Clone Core Architecture / Cross-cutting invariants
- `AGENTS.md` —— Persistent Storage Compatibility / Feature Quality Contract
- `docs/desktop/02-architecture.md` —— 三层进程模型
- `docs/ui-clone/03-server-architecture.md` —— Server API / WS 设计原则
- `src/server/staticH5.ts` —— 静态 SPA 伺服与 `CLAUDE_H5_DIST_DIR` 候选路径
- `src/server/h5AccessPolicy.ts` —— H5 / loopback 鉴权分类
- `desktop/src/lib/desktopRuntime.ts` —— `isTauriRuntime()` / `isBrowserH5Runtime()` / H5 连接初始化
