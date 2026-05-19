# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Authoritative Contracts

## Project Layout

This is a Bun-based monorepo with several largely independent surfaces. Each has its own `package.json` / dependency install:

- **`src/`** — root CLI and local API/WebSocket server. Entrypoint is `bin/claude-haha` (bash) → `src/entrypoints/cli.tsx` (Ink TUI via Bun). The local server lives in `src/server/` and is started by `desktop/` to back the GUI. `src/tools/` holds agent tool implementations (Bash, Edit, Grep, …); `src/commands/` holds slash commands; `src/services/` holds API/MCP/OAuth/provider logic; `src/skills/` holds the Skills system. `preload.ts` is loaded via `bunfig.toml` and injects the `MACRO` global plus `chdir`s into `CALLER_DIR` so the CLI runs in the user's cwd, not the repo root.
- **`desktop/`** — Tauri 2 shell + React/Vite UI. `desktop/src/` is the React app (zustand stores in `stores/`, API clients in `api/`, components in `components/`). `desktop/src-tauri/` is the Rust glue. `desktop/sidecars/` and `desktop/scripts/build-sidecars.ts` package the CLI as a Tauri sidecar. Has its own `bun install`.
- **`adapters/`** — IM bridges (`telegram/`, `feishu/`, `wechat/`, `dingtalk/`) with shared code in `common/`. Independent `bun install` required (`cd adapters && bun install`) before `bun run check:adapters`.
- **`docs/`** — VitePress site. Note: the docs CI workflow (`.github/workflows/deploy-docs.yml`) uses `npm ci`, not Bun, on Node 22 — keep `package-lock.json` in sync with `package.json` whenever root deps change or the docs build will fail.
- **`scripts/quality-gate/`** — implementation of `bun run verify` / `quality:pr` / `quality:baseline` / `quality:release`. `scripts/pr/` holds path-aware PR policy checks. `scripts/release.ts` cuts desktop releases (updates versions, refreshes `Cargo.lock`, requires matching `release-notes/vX.Y.Z.md`, creates the annotated tag).

The desktop app talks to the root server over HTTP/WebSocket; the desktop UI does not import `src/` directly. When changing chat/agent/permission flows you almost always touch both `src/server/` (or `src/tools/`) and `desktop/src/`.

## Desktop Clone — Core Architecture

This repo's defining work is a desktop GUI clone of Claude Code Desktop, layered on top of the leaked Claude Code CLI. The CLI source under `src/` is treated as **read-only upstream** as much as possible; the clone lives in two new layers — `src/server/` (Bun HTTP/WS gateway) and `desktop/` (Tauri + React shell) — that delegate the actual agent loop back into the CLI by spawning it. Read `docs/ui-clone/01-requirements.md`, `02-ui-design-spec.md`, `03-server-architecture.md`, and `docs/desktop/02-architecture.md` before making non-trivial changes here; the server doc and the actual code have diverged in places, and the actual code wins.

### Three-tier process model

```
Tauri main (Rust)  ──spawns──▶  Server sidecar (Bun)  ──spawns one per session──▶  CLI subprocess
   │                                  ▲                                                  │
   │                                  └─── /sdk/<sessionId> WS (server ⇄ CLI's SDK) ─────┘
   ▼
WebView ──── HTTP /api/* + WS /ws/<sessionId> ────▶  Server sidecar
```

- **Tauri** (`desktop/src-tauri/src/lib.rs`) reserves a free port with `127.0.0.1:0`, spawns the bundled `claude-sidecar server --port <port>`, polls TCP until ready (~10s), then loads the WebView. Exposes two commands: `get_server_url`, `restart_adapters_sidecar`. `RunEvent::Exit` kills both sidecars.
- **Server** (`src/server/index.ts` → `server.ts`) is `Bun.serve` with three URL spaces: `/api/*` (REST, see `router.ts`), `/ws/<sessionId>` (client WS), `/sdk/<sessionId>` (internal — the CLI subprocess connects back to its own server via this path; gated by `classifyH5Request` to `internal-sdk`). `/proxy/*` is the protocol-translating reverse proxy for OpenAI-compatible providers; `/health` and static H5 assets round it out.
- **CLI subprocess** is spawned per session by `ConversationService.startSession()` in `src/server/services/conversationService.ts`. Args include `--print --verbose --sdk-url <ws://…/sdk/<sessionId>?token=…> --input-format stream-json --output-format stream-json --include-partial-messages` plus `--resume <id>` or `--session-id <id>` and `--worktree <slug>` when applicable. The CLI streams JSON to stdout (parsed back into `ServerMessage` events) and dials `--sdk-url` as an outbound WebSocket so the server can push permission decisions / runtime config back into the live agent loop.

### Server layout (`src/server/`)

- `index.ts` — entry; calls `startServer()` from `server.ts`, registers SIGTERM/SIGINT cleanup that kills every active CLI subprocess via `conversationService.getActiveSessions()` + `stopSession`.
- `server.ts` — fetch handler doing CORS, H5-access gating, auth, then dispatch into REST / WS / SDK / proxy / static. Boots `teamWatcher` (polls `~/.claude/teams/` every 3s and pushes `team_*` WS events) and `cronScheduler` (drives `scheduled-tasks`).
- `router.ts` — switch on the second URL segment to one of ~25 `handle*Api` modules under `api/`. Note: `/api/sessions/:id/chat/*` is intercepted and forwarded to `handleConversationsApi`, and `/api/permissions/*` lives inside `handleSettingsApi`.
- `api/` — thin REST adapters; almost every handler delegates to a service in `services/`.
- `services/` — the actual logic. The big ones to know:
  - `conversationService` — CLI subprocess manager (one `SessionProcess` per session ID; tracks `outputCallbacks`, `pendingPermissionRequests`, the `sdkSocket`, and `pendingOutbound` for messages queued before the SDK socket connects).
  - `sessionService` — JSONL file CRUD against `~/.claude/projects/<sanitized>/<sid>.jsonl` (the same format the CLI writes), plus session launch info / worktree metadata.
  - `repositoryLaunchService` — branch / worktree resolution; `prepareSessionWorkspace` materializes a worktree when needed.
  - `teamWatcher` — `~/.claude/teams/` polling → `team_update` / `team_created` / `team_deleted` WS events.
  - `cronService` / `cronScheduler` — `~/.claude/scheduled_tasks.json` plus the in-process scheduler.
  - `providerService` / `proxy/handler` — provider config + protocol-translating proxy (anthropic / openai_chat / openai_responses) with per-provider model-slot mapping (`main` / `haiku` / `sonnet` / `opus`).
  - `desktopCliLauncherService` — installs the bundled CLI launcher at runtime so `ConversationService` can spawn it from any cwd.
  - `persistentStorageMigrations` — `ensurePersistentStorageUpgraded()` runs at the top of every fetch; this is where forward migrations for desktop-owned JSON live.
  - `h5AccessService` + `h5AccessPolicy.ts` — gates which requests count as `local-trusted` vs need a one-time H5 token.
- `ws/handler.ts` — connection lifecycle for `/ws/*` and `/sdk/*`. Client WS messages route through `conversationService` to the CLI subprocess; CLI stdout JSON gets parsed and emitted back through `sendToSession`. Holds five interesting per-session caches: `sessionSlashCommands`, `sessionCleanupTimers` (5-min disconnect grace), `sessionStopRequested` (suppresses `CLI_ERROR` after a user-initiated stop), `sessionTitleState` (drives auto-title generation off the first user message), and `runtimeOverrides` (in-flight provider/model swaps).
- `ws/events.ts` — **the wire-format contract**. `ClientMessage` / `ServerMessage` / `ChatState` / `TeamMemberStatus` / `ComputerUsePermissionRequest+Response` are the source of truth — when adding a new chat event, add it here first, then handle it on both sides.

### Desktop layout (`desktop/src/`)

- `App.tsx` is one screen: `<AppShell />`. `AppShell` bootstraps via `initializeDesktopServerUrl()` (Tauri command in native, `127.0.0.1:3456` env fallback elsewhere), then `useSettingsStore.fetchAll()`, then `tabStore.restoreTabs()`. The page tree is `Sidebar | (TabBar + ContentRouter)` with `ToastContainer` and `UpdateChecker` overlays.
- `components/layout/ContentRouter.tsx` is the actual top-level "router" — dispatches on the active tab's `type` to `<EmptySession>` / `<ActiveSession>` / `<ScheduledTasks>` / `<Settings>` / `<TerminalSettings>`. Terminal tabs are rendered persistently in parallel and hidden via opacity to keep PTY state alive.
- `pages/ActiveSession.tsx` is the heart of the chat UX; uses `chatStore` heavily.
- `components/chat/` — message rendering: `MessageList`, `AssistantMessage`, `UserMessage`, `ToolCallBlock` / `ToolCallGroup`, `ThinkingBlock`, `DiffViewer`, `CodeViewer`, `PermissionDialog`, `ComputerUsePermissionModal`, `AskUserQuestion`, `ChatInput`, `StreamingIndicator`, `SessionTaskBar`, `MermaidRenderer`. The matching design tokens live in `docs/ui-clone/02-ui-design-spec.md`.
- `components/controls/` — `ModelSelector`, `PermissionModeSelector`. `components/teams/TeamStatusBar.tsx` is the bottom strip for Agent Teams; `components/tasks/` is the scheduled-task UI; `components/workspace/` is the right-side code-changes/diff panel.
- `api/` — one client module per server resource (15+ files). `api/client.ts` is the shared `fetch` wrapper (timeout, auth header, redaction-aware diagnostics reporter); `api/websocket.ts` is the per-session `WebSocketManager` with auto-reconnect (exponential backoff, capped at 30s), 30s ping/pong, and a `pendingMessages` queue for sends made while the socket is reconnecting.
- `stores/` — Zustand, ~14 stores split by domain. The ones that matter most:
  - `chatStore` — **per-session** state map (`sessions[sessionId]`); owns streaming text, active tool/thinking ids, pending permissions (regular + computer-use), token usage, status verb, slash-command list, agent task notifications, the elapsed-time interval, and `composerPrefill`. `connectToSession` / `sendMessage` / `stopGeneration` / `respondToPermission` / `setSessionRuntime` / `setSessionPermissionMode` are the WS-bound action surface; `loadHistory` / `reloadHistory` rehydrate from REST.
  - `sessionStore` — flat session list, project filter, batch-select state, rename/delete.
  - `tabStore` — open tab order; persisted to `localStorage` under `cc-haha-*` keys, restored on bootstrap. Settings tab uses the well-known id `SETTINGS_TAB_ID`.
  - `sessionRuntimeStore` — per-session model + effort + provider override (chat-store calls into it).
  - `settingsStore` / `providerStore` / `taskStore` / `teamStore` / `agentStore` / `skillStore` / `adapterStore` / `mcpStore` / `pluginStore` / `cliTaskStore` / `terminalPanelStore` / `workspacePanelStore` / `workspaceChatContextStore` / `uiStore` / `updateStore` / `hahaOAuthStore` — domain-scoped, mostly REST-backed.

### WebSocket wire format (the contract)

The single source of truth is `src/server/ws/events.ts` (server) and `desktop/src/types/chat.ts` (client mirror — keep in sync). Round-trip:

- Client → server: `prewarm_session`, `user_message`, `permission_response`, `computer_use_permission_response`, `set_permission_mode`, `set_runtime_config`, `stop_generation`, `ping`.
- Server → client: `connected`, `content_start` / `content_delta` (streaming text or tool_use input deltas), `tool_use_complete`, `tool_result`, `permission_request`, `computer_use_permission_request`, `message_complete` (with `TokenUsage`), `thinking`, `status` (with `ChatState` and a UI verb), `error`, `system_notification`, `pong`, `team_update` / `team_created` / `team_deleted`, `task_update`, `session_title_updated`.

`ChatState` is `'idle' | 'thinking' | 'tool_executing' | 'streaming' | 'permission_pending'` — the desktop spinner / "Crafting…" copy keys off this. Adding a new state means updating both the union, the desktop `chatStore` reducer, and the spinner verb pool in `desktop/src/config/spinnerVerbs.ts`.

### Desktop external-access channels (the only escape hatches)

`desktop/src/` is the WebView. It has **three** ways to reach anything outside its own React tree, and that's it:

1. **`/api/*` REST** via `desktop/src/api/client.ts` → `src/server/router.ts`. All data CRUD, settings, sessions, providers, adapters, MCP, skills, plugins, scheduled tasks, teams, computer-use config, diagnostics, doctor, h5-access, OAuth, filesystem queries.
2. **`/ws/<sessionId>` WebSocket** via `desktop/src/api/websocket.ts` → `src/server/ws/handler.ts`. Streaming chat, permission requests/responses, runtime config swaps, team/task/title push events.
3. **Tauri `invoke(...)` + `listen(...)`** for the handful of capabilities a Bun HTTP server can't provide. Audited list (greppable as `@tauri-apps` and `invoke<` / `invoke('`):

   | Capability | Command(s) / plugin | Where |
   |---|---|---|
   | Server URL bootstrap | `invoke('get_server_url')` | `lib/desktopRuntime.ts` |
   | Native PTY terminal | `terminal_spawn` / `terminal_write` / `terminal_resize` / `terminal_kill` + events `terminal-output` / `terminal-exit` | `api/terminal.ts`, `pages/TerminalSettings.tsx` |
   | macOS notifications | `macos_notification_permission_state` / `macos_request_notification_permission` / `macos_send_notification` | `lib/desktopNotifications.ts` |
   | Windows notifications | `plugin:notification\|is_permission_granted` / `plugin:notification\|request_permission` / `open_windows_notification_settings` + `plugin-notification` plugin | `lib/desktopNotifications.ts` |
   | Adapter sidecar restart | `invoke('restart_adapters_sidecar')` | `stores/adapterStore.ts` |
   | Auto-update lifecycle | `prepare_for_update_install` / `cancel_update_install` + `plugin-updater` + `plugin-process.relaunch` | `stores/updateStore.ts` |
   | Window controls | `@tauri-apps/api/window` (`getCurrentWindow`, `UserAttentionType`) | `components/layout/{TitleBar,WindowControls,TabBar,Sidebar}.tsx` |
   | Native menu / file dialog / external links | `api/event.listen('native-menu-navigate', …)`, `plugin-dialog.open`, `plugin-shell.open` | `AppShell.tsx`, `DirectoryPicker.tsx`, `ComputerUseSettings.tsx`, `Settings.tsx`, `ClaudeOfficialLogin.tsx` |
   | App metadata | `@tauri-apps/api/app` | `pages/Settings.tsx` |

Verified absent in `desktop/src/`: imports from the repo `src/` tree, `node:fs`, `fs`, `os`, `os.homedir`, `Bun.spawn`. There is **no** path that reads `~/.claude/...` directly from the WebView, and no path that spawns the CLI from the WebView. The PTY terminal is the only feature that bypasses `src/server/` entirely (it goes WebView → Tauri Rust → OS), so it does not work in the H5 remote-access mode by design.

Decision rule for new work:
- New "thing the CLI can already do" exposed in the GUI → REST/WS through `src/server/`. Never `invoke` for this.
- New "thing the OS or Tauri main process must do" (window, notification, dialog, sidecar lifecycle, updater, native PTY) → new `#[tauri::command]` in `desktop/src-tauri/src/lib.rs` plus capability entries in `desktop/src-tauri/capabilities/*.json`, then `invoke(...)` from the WebView.

### Cross-cutting invariants — break these at your peril

1. **CLI/UI file-system parity**: the desktop reads and writes the *same* files the CLI does (`~/.claude/projects/**/*.jsonl`, `~/.claude/settings.json`, `~/.claude/scheduled_tasks.json`, `~/.claude/teams/**`, `~/.claude/cc-haha/providers.json`, `~/.claude/adapters.json`, etc.). Sessions opened in the CLI must show up in the desktop and vice-versa. Any persistence change goes through `services/persistentStorageMigrations.ts` and ships with a fixture-based regression test (see `Persistent Storage — Treat as Hot` above).
2. **Don't import `src/` from `desktop/src/`**: the desktop talks to `src/server/` over HTTP/WS only. The two have different runtimes (Bun + Node fs vs. browser/Tauri WebView) and bundling.
3. **`preload.ts` chdir trap**: the CLI's `preload.ts` reads `CALLER_DIR` and `process.chdir`s into it on startup. When `ConversationService` spawns the CLI, it must explicitly override `CALLER_DIR` and `PWD` to the session's `workDir` in the spawned env — otherwise inherited values from the Tauri-launched server (often `/`) silently move the CLI's "primary working directory" to root. See the long comment at `conversationService.ts` ~line 218.
4. **Auto-loaded `.env` clobbers desktop provider config**: when the server spawns the CLI, it sets `CC_HAHA_SKIP_DOTENV=1`. `bin/claude-haha` then passes `--env-file=/dev/null` to Bun so a stale repo-root `.env` cannot re-inject `ANTHROPIC_API_KEY`. Don't remove this without rethinking provider precedence.
5. **`/sdk/*` is internal only**: the CLI's outbound SDK WebSocket connects to `/sdk/<sessionId>?token=…`. `server.ts` rejects requests there unless `classifyH5Request` returns `internal-sdk`. Don't proxy or expose it.
6. **One CLI per session**: `ConversationService.sessions` is a `Map<sessionId, SessionProcess>` (don't multiplex). `deletedSessions` is a tombstone set so a delete during startup correctly aborts. `pendingOutbound` queues messages bound for the SDK socket before it has dialed in.
7. **Disconnect grace, not teardown**: a client `close` does **not** kill the CLI subprocess. `handler.ts` puts it on `sessionCleanupTimers` for ~5 minutes and lets a reconnect cancel the timer. This is what makes session reconnection feel instant.
8. **WS reconnect is the client's job**: `desktop/src/api/websocket.ts` handles backoff and pending-message buffering. Components must subscribe via `wsManager.onMessage(sessionId, …)` and unsubscribe on unmount; do not assume one socket per render.

### Where features actually land (typical change-touch list)

- **New chat UI affordance**: `desktop/src/components/chat/*`, the relevant slice of `chatStore`, possibly a new field on `ServerMessage` or `ClientMessage` (in `events.ts` *and* `types/chat.ts`).
- **New tool-call rendering**: `ToolCallBlock` / `ToolCallGroup` (and `chatBlocks` grouping logic) — but the *tool* itself usually lives in `src/tools/` and is upstream code; only touch it if the desktop genuinely can't render the existing output.
- **New permission flow**: plumb `permission_request` / `permission_response` through `conversationService` ⇄ CLI, render in `PermissionDialog`, persist rule choices via `settingsService`.
- **New REST resource**: `src/server/api/<resource>.ts` + `services/<resource>Service.ts` + `router.ts` case + `desktop/src/api/<resource>.ts` + a Zustand store if it's stateful, with tests on both sides.
- **Scheduled tasks / cron changes**: `services/cronService.ts` + `cronScheduler.ts` + `desktop/src/pages/ScheduledTasks.tsx` + `pages/NewTaskModal.tsx` + `taskStore`.
- **Agent Teams visualization**: `services/teamWatcher.ts` (polling source) + `services/teamService.ts` + `teamStore` + `components/teams/TeamStatusBar.tsx` + the `team_*` WS events.
- **Computer Use**: `services/computerUseApprovalService.ts` + `api/computer-use.ts` + `ComputerUsePermissionModal` + the `computer_use_permission_*` WS events.

When in doubt, search `docs/ui-clone/` and `docs/desktop/` for design intent, then `git grep` the WS event name (or the API path) — it almost always touches exactly the layers listed above.

### Web target

`desktop/` is also the source of the browser bundle. `BUILD_TARGET=web vite build` writes to `desktop/dist-web/`; `bun run start:web` boots the server with `CC_HAHA_RUNTIME=web` and points `CLAUDE_H5_DIST_DIR` at that dir. In web mode:

- Per-session cwd is auto-created at `workspaces/<sessionId>/` in the repo root and **never** auto-cleaned (see `src/server/services/webWorkspaceService.ts`).
- PTY terminal, adapter sidecar restart, auto-update, and native dialog/shell are unavailable; UI entries are hidden via build-time `IS_WEB_BUILD` gates.
- System notifications fall back to the Web Notification API (`desktop/src/lib/desktopNotifications.ts`).
- All `@tauri-apps/*` access goes through `desktop/src/lib/tauriBridge.ts`, which throws `TauriUnavailableError` or no-ops outside Tauri.
- No user auth, no multi-user, no production deployment — local or LAN dev only.
- E2E lane: `bun run check:web-e2e` (Playwright); not part of the default `bun run verify` chain.

Full design / step plan: `docs/web/web-deployment-plan.md` and `docs/superpowers/plans/2026-05-19-web-target.md`.

## Common Commands

Root (run from repo root):

- `bun install` — install root deps (does not install `desktop/` or `adapters/` deps).
- `./bin/claude-haha` or `bun run start` — run the CLI/TUI locally.
- `SERVER_PORT=3456 bun run src/server/index.ts` — start the local API/WebSocket server that backs `desktop/`.
- `bun run docs:dev` / `bun run docs:build` — VitePress docs.
- `bun run verify` — **the** local gate before claiming work is ready (equivalent to `bun run quality:pr`). Writes `artifacts/quality-runs/<ts>/report.md` and `artifacts/coverage/<ts>/coverage-report.md`. Does NOT call real models.
- Narrow lanes (run before `verify` when iterating): `bun run check:server`, `bun run check:desktop`, `bun run check:adapters`, `bun run check:native`, `bun run check:docs`, `bun run check:coverage`, `bun run check:quarantine`.
- Live lanes (need real provider credentials): `bun run quality:providers` to list selectors, then `bun run quality:gate --mode baseline --allow-live --provider-model <provider:model[:label]>` or `--mode release` for release gating, or `bun run quality:smoke --provider-model <selector>` for just the smoke lanes.
- `bun run hooks:install` — installs a pre-push hook that runs the same gate.

Desktop (run from `desktop/`):

- `bun install` then `bun run dev` — Vite dev server for the web shell.
- `bun run tauri dev` — full Tauri desktop dev loop.
- `bun run build` — `tsc -b && vite build` (production web bundle).
- `bun run lint` — `tsc --noEmit` (this repo's "lint" is type-checking, there is no ESLint).
- `bun run test` — Vitest. Single test file: `bun run test -- --run path/to/file.test.ts`. Single test name: add `-t "<name>"`. UI mode: `bun run test:ui`.
- `bun run build:macos-arm64` / `bun run build:windows-x64` — canonical local packaging entrypoints; outputs land in `desktop/build-artifacts/<platform>/`.

Adapters: `cd adapters && bun install && bun test` (or `bun test:telegram` / `:feishu` / `:wechat` / `:dingtalk`).
