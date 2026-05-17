# Desktop Open Project Targets Design

## Summary

Add a Codex app style project-open control to the desktop top-right toolbar. The control opens the project directory in a detected local IDE/editor or in the platform file manager. It must use the same directory the agent is actually working in, including a materialized session worktree, so the user never opens a different checkout from the one Claude is editing.

## Goals

- Show a compact top-right toolbar button modelled after the Codex app UI: primary app icon plus a dropdown affordance when multiple targets exist.
- Detect common local IDE/editor targets silently and display only installed, openable IDEs.
- Always provide a platform file manager fallback: Finder on macOS, Explorer on Windows, and a generic file manager on Linux if supported.
- Open the current session's effective working directory first. For active repository sessions this means the materialized worktree path when present; otherwise the session cwd/workDir. Before a session starts, use the launch workDir currently selected in the composer.
- Keep this feature independent from Computer Use and from IDE MCP/extension connection state.
- Avoid changing branches, creating worktrees, modifying repo state, or writing persistent user settings.

## Non-Goals

- No external Terminal/iTerm/Warp launch in the first version.
- No custom user-defined open commands.
- No automatic IDE/plugin installation.
- No H5/mobile browser access to local app launching.
- No persistent global preference file in the first version. In-memory cache is enough.

## Current Code Context

- `desktop/src/components/layout/TabBar.tsx` already owns the top-right toolbar area with terminal and workspace-panel buttons.
- `desktop/src/components/shared/RepositoryLaunchControls.tsx` owns the pre-session workDir, branch, and worktree launch controls.
- Active sessions expose working-directory context through session data, `SessionGitInfo`, and the existing `ProjectContextChip` usage in chat surfaces.
- Server-side repository launch logic in `src/server/services/repositoryLaunchService.ts` already distinguishes source repo, requested workDir, and worktree path.
- The current Tauri app already includes `@tauri-apps/plugin-shell` and `shell:allow-open`, but Tauri's current recommendation is the opener plugin for path/file-manager opening. The implementation plan can choose either a server API route or a Tauri command; the preferred design keeps platform detection and launching in the server/native boundary rather than scattering it through UI components.

## Product Behavior

### Toolbar Control

The top-right toolbar gets a new project-open control before the existing terminal/workspace buttons.

- If at least one IDE/editor is detected, show the highest-priority detected IDE as the primary icon and include a dropdown chevron.
- If no IDE/editor is detected, show the platform file manager icon and behave as a single-click file-manager opener.
- The dropdown only lists detected IDE/editor targets plus the file-manager fallback. It does not show unsupported or missing IDEs.
- The visual style follows the Codex app reference: compact rounded segmented button, icon-first, subtle hover, dropdown menu with app icons and labels.

### Target Priority

Initial IDE/editor target registry:

- macOS: VS Code, Cursor, Sublime Text, Antigravity, GoLand, PyCharm, Finder.
- Windows: VS Code, Cursor, Sublime Text, GoLand, PyCharm, Explorer.
- Linux: VS Code, Cursor, Sublime Text, file manager fallback if available.

Ordering:

1. Last successfully opened IDE target during this app runtime, if still detected.
2. VS Code.
3. Cursor.
4. Antigravity.
5. Sublime Text.
6. GoLand.
7. PyCharm.
8. File manager fallback.

The first version stores the last successful target only in memory.

### Effective Path Resolution

The open path must match the agent's active working directory.

Resolution order:

1. Active session materialized worktree path when present.
2. Active session cwd/workDir from session metadata.
3. Active session git workDir if exposed by `SessionGitInfo`.
4. Pre-session launch workDir selected in the composer.
5. No target path: disable the control and show no menu.

The server revalidates the path before launching:

- It must exist.
- It must be a directory.
- It must not require any branch switch or worktree creation.

## Architecture

### Server API

Add a focused server API surface, tentatively under `src/server/api/open-targets.ts`.

Endpoints:

- `GET /api/open-targets`
  - Returns platform, detected open targets, file-manager fallback, cache metadata.
  - Performs silent detection and uses a short in-memory cache.
- `POST /api/open-targets/open`
  - Body: `{ targetId: string, path: string }`.
  - Validates the target is currently supported or is the file-manager fallback.
  - Validates the path is an existing directory.
  - Opens the path with the selected target.
  - Returns `{ ok: true, targetId, path }` or a typed error.

The route should be deny-by-default: only known target IDs from the registry are accepted.

### Target Registry

Create a small registry with one responsibility: platform-specific detection and open command metadata.

Suggested module:

- `src/server/services/openTargetService.ts`

Responsibilities:

- Define target IDs, display names, platform support, icon keys, detection candidates, and open behavior.
- Detect installed/openable targets without requiring Computer Use Python helpers.
- Cache detection results in memory for a short TTL.
- Open the selected target using safe argument arrays, never shell-concatenated strings.

Detection examples:

- macOS:
  - Check common `.app` paths under `/Applications` and `~/Applications`.
  - For VS Code-family apps, also check CLI commands such as `code`, `cursor`, and `antigravity` when available.
  - Finder is always available.
- Windows:
  - Check PATH commands such as `code.cmd`, `cursor.cmd`, `subl.exe`, and JetBrains launcher commands when available.
  - Check common install locations only where cheap and deterministic.
  - Explorer is always available.
- Linux:
  - Check PATH commands for known targets.
  - Use `xdg-open` or platform file manager fallback only when available.

Opening examples:

- IDE/editor: launch known executable/CLI with the directory path as a single argument.
- Finder/Explorer:
  - macOS: `open <path>` or equivalent native opener.
  - Windows: `explorer.exe <path>`.
  - Linux: `xdg-open <path>` when available.

### Desktop UI

Create a dedicated component rather than expanding `TabBar.tsx` with detection logic.

Suggested files:

- `desktop/src/api/openTargets.ts`
- `desktop/src/stores/openTargetStore.ts`
- `desktop/src/components/layout/OpenProjectMenu.tsx`
- tests next to the component/store or in existing desktop test locations.

Responsibilities:

- `openTargetsApi`: typed API client.
- `openTargetStore`: in-memory target list, loading/error state, short TTL, last successful target for this runtime.
- `OpenProjectMenu`: renders the Codex app style control and dropdown.
- `TabBar`: passes active-session path context into `OpenProjectMenu` and keeps layout ownership.

The component should be disabled outside Tauri/desktop runtime and hidden if no valid path is available.

## Error Handling

- Detection failure: keep Finder/Explorer fallback if platform supports it; do not block the toolbar.
- Open target disappeared after cache: refresh targets once, then show a toast-style error if still unavailable.
- Path missing: show a concise failure message and disable retry until session/path changes.
- Unsupported target ID: server returns 400; UI treats it as stale cache and refreshes.
- Command failure: server returns typed message with stderr redacted to a short detail.

## Testing

Server tests:

- Registry returns only installed/detected IDE targets plus file-manager fallback.
- Missing IDEs are not returned.
- File-manager fallback is returned when no IDE is detected.
- `POST /api/open-targets/open` rejects unknown target IDs.
- `POST /api/open-targets/open` rejects missing or non-directory paths.
- Open command uses argument arrays and never shell-concatenated user paths.

Desktop tests:

- `OpenProjectMenu` shows IDE icon and dropdown when IDE targets exist.
- `OpenProjectMenu` degrades to Finder/Explorer single action when only file-manager fallback exists.
- Missing targets are not rendered.
- `TabBar` renders the control for active session tabs and passes the effective worktree path.
- Store caches target detection and refreshes after TTL or stale-target failure.

Verification:

- Run narrow server tests for open-target service/API.
- Run narrow desktop tests for `OpenProjectMenu`, store, and TabBar integration.
- Run `bun run check:server` and `bun run check:desktop`.
- Run `bun run verify` before final completion unless blocked by unrelated existing failures.

## Risks

- IDE command names differ by installation method, especially JetBrains and Windows. Mitigation: start with known common commands and deterministic app paths, keep fallback always available.
- Tauri shell/open APIs differ from current recommendations. Mitigation: centralize opening server-side first; evaluate Tauri opener plugin only if the implementation needs native path reveal behavior.
- Top-right toolbar can get crowded. Mitigation: compact icon-only control, dropdown only when useful, no text labels in toolbar.

## References

- Tauri Opener plugin docs: https://v2.tauri.app/plugin/opener/
- Tauri Shell plugin docs: https://v2.tauri.app/zh-cn/plugin/shell/
