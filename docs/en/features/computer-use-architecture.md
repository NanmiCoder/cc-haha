# Computer Use Architecture

> This page describes the Computer Use tools, authorization model, platform executors, and current safety boundaries. For setup, start with the [Computer Use guide](./computer-use.md).

## Layers

```text
Model / MCP client
  ↓
Tool definitions and argument validation
  src/vendor/computer-use-mcp/tools.ts
  ↓
Session authorization and safe dispatch
  src/vendor/computer-use-mcp/toolCalls.ts
  src/vendor/computer-use-mcp/mcpServer.ts
  ↓
Claude Code Haha integration
  src/utils/computerUse/
  ↓
Python bridge
  src/utils/computerUse/pythonBridge.ts
  ↓
Platform helper
  runtime/mac_helper.py
  runtime/win_helper.py
```

The tool and authorization layers remain platform-independent where possible. Platform differences are concentrated in `ComputerExecutor` capabilities and the Python helpers.

## Tool registration

`buildComputerUseTools()` creates the MCP tool definitions. The codebase contains 27 schemas:

- 24 base control tools
- 3 Teach tools: `request_teach_access`, `teach_step`, and `teach_batch`

Teach tools are gated by `caps.teachMode`. When a host does not enable that capability, `ListTools` returns only the base tools. “The code defines 27 tools” does not mean that every runtime always exposes all 27.

There are two MCP Server construction paths:

- `src/utils/computerUse/mcpServer.ts` creates the CLI server and adds sanitized installed-application names to the access tool description.
- `src/vendor/computer-use-mcp/mcpServer.ts` binds the real session context, including the latest screenshot and grant state.

`src/utils/computerUse/setup.ts` creates the dynamic MCP configuration and allowed tool names. Calls are still controlled by Computer Use's own application authorization flow; being present in `allowedTools` is not permission to operate arbitrary applications.

## Session state

Each bound session tracks:

- authorized applications and permission tiers
- clipboard and system-key grants
- selected display
- latest screenshot and coordinate geometry
- Computer Use session lock
- whether Teach mode is active

The latest screenshot is the coordinate reference for later clicks. Screenshot dimensions, logical display size, scale factor, and display origin must move together or Retina and multi-display setups will target the wrong location.

## Coordinates and screenshots

Tool descriptions expose exactly one coordinate mode to the model:

- `pixels`: coordinates come from the most recent screenshot seen by the model
- `normalized_0_100`: coordinates are percentages of screen width and height

The tool description and executor read the same frozen coordinate configuration so the model cannot be instructed in one mode while the host converts another.

Typical mapping:

```text
Model screenshot coordinate
  → map through screenshot size to logical display size
  → add target display origin
  → send to the platform helper
```

Screenshots are resized to an image budget. Documentation should not hard-code a single output resolution.

## Authorization and action checks

Computer Use combines several checks before an action rather than relying on a single permission dialog.

### Global switch and OS permissions

- `CLAUDE_COMPUTER_USE_ENABLED=0` or managed configuration can disable the feature.
- macOS requires Accessibility and Screen Recording.
- Windows does not use macOS TCC, but it still follows application grants and action checks.

### Session exclusion

A session lock ensures that only one session controls system input at a time. The lock carries process and session information and supports stale-process recovery. Normal recovery should not require users to delete it manually.

### Application allowlist and frontmost check

Before input, Computer Use reads the frontmost application. If it is not in the session allowlist, the action is rejected. Grants use `read`, `click`, and `full` tiers.

Screenshot behavior differs by platform:

| Platform | `screenshotFiltering` | Behavior |
|---|---|---|
| macOS | `native` | Excludes unauthorized application windows at screenshot composition time |
| Windows | `none` | May capture every visible window; the input allowlist still applies |

“Input cannot target an unauthorized Windows application” does not imply that screenshots hide other Windows applications.

### Clipboard and system keys

Clipboard read, clipboard write, and system-level key combinations use separate grant flags. Multiline typing may use a clipboard fast path, and the executor attempts to preserve and restore clipboard contents, but only after the user grants the relevant capability.

High-risk system key combinations also pass a dedicated key check. Ordinary application authorization does not automatically permit quitting applications, switching applications, locking the screen, or similar system actions.

### Pixel staleness

The tool layer retains pixel comparison support for detecting a UI that changed after the model saw it. `pixelValidation` is disabled in the current default configuration, so the model should take a fresh screenshot after UI changes.

## Capabilities that are not currently provided

### No global Escape abort

`src/utils/computerUse/escHotkey.ts` does not register a system-wide Escape abort. The desktop host and documentation must not promise that Escape can stop Computer Use from every application.

### No automatic window hiding

The executor keeps `prepareForAction()` and `previewHideSet()` interfaces, but the current macOS and Windows helpers do not hide windows based on the allowlist. `unhideComputerUseApps()` is also a no-op.

Consequences:

- Do not present `hideBeforeAction` as an implemented privacy guarantee.
- On Windows, users should close or minimize sensitive windows themselves.
- On macOS, the privacy boundary comes from native screenshot filtering, not window hiding.

## Teach flow

Teach adds a guided overlay on top of the same authorization and action dispatcher:

```text
request_teach_access
  → user approves teaching applications
  → Teach session activates
  → teach_step / teach_batch
  → show guidance, wait for Next, run actions, return a new screenshot
  → user exits or the turn ends
```

Important constraints:

- Teach has a separate authorization entry and does not inherit regular clipboard or system-key grants.
- The `teach_step` explanation is the primary narration visible in the overlay.
- `teach_batch` is appropriate for predictable consecutive steps; use individual steps when the UI outcome is uncertain.
- A regular permission dialog cannot be requested while Teach is hiding the main window.
- After the user exits, further Teach calls must stop.
- The host capability decides whether Teach tools are exposed.

## Python bridge

`src/utils/computerUse/pythonBridge.ts`:

1. Resolves `.runtime` in the managed user configuration directory.
2. Synchronizes the current platform helper and requirements.
3. Creates a venv with the detected or configured Python.
4. Installs or updates dependencies based on the requirements hash.
5. invokes the helper with `command + JSON payload`.
6. returns a uniform JSON result or error to TypeScript.

Runtime files:

| Path | Responsibility |
|---|---|
| `runtime/mac_helper.py` | macOS screenshots, applications, mouse, keyboard, and clipboard |
| `runtime/win_helper.py` | Windows equivalents |
| `runtime/requirements.txt` | macOS Python dependencies |
| `runtime/requirements-win.txt` | Windows Python dependencies |

Each helper invocation is a bounded subprocess request. Helpers do not read model state; TypeScript owns session authorization and action policy.

## Host integration

### CLI

`src/utils/computerUse/` is responsible for:

- macOS/Windows support detection
- `ComputerExecutor` creation
- dynamic MCP setup
- permission UI and session state
- preauthorized applications and Python selection

### Desktop

The desktop Settings page uses `src/server/api/computer-use.ts` to:

- read and change the enabled state
- inspect and install the Python runtime
- check macOS system permissions
- manage preauthorized applications
- manage clipboard and system-key grants

Settings is the configuration entry point. Actual calls still execute inside the CLI session's MCP and authorization boundaries.

## Key source files

| Path | Responsibility |
|---|---|
| `src/vendor/computer-use-mcp/tools.ts` | Tool schemas and Teach tools |
| `src/vendor/computer-use-mcp/toolCalls.ts` | Dispatch, authorization, and safety checks |
| `src/vendor/computer-use-mcp/mcpServer.ts` | MCP Server and session binding |
| `src/vendor/computer-use-mcp/types.ts` | Capabilities, grants, and session types |
| `src/utils/computerUse/common.ts` | Platform support and capabilities |
| `src/utils/computerUse/gates.ts` | Global switch and sub-capability defaults |
| `src/utils/computerUse/executor.ts` | Python bridge executor |
| `src/utils/computerUse/pythonBridge.ts` | venv, dependencies, and subprocess protocol |
| `src/utils/computerUse/wrapper.tsx` | CLI permission UI and session context |
| `src/server/api/computer-use.ts` | Desktop Settings API |
| `desktop/src/pages/ComputerUseSettings.tsx` | Desktop Settings UI |

## Verification priorities

- Keep tool schemas synchronized with dispatchable actions.
- Keep model-facing coordinate descriptions aligned with executor conversion.
- Do not mix macOS and Windows capability claims.
- Reject input when the frontmost application is unauthorized.
- Windows tests must not assume screenshot filtering.
- Do not expose Teach tools when the host capability is off.
- Preserve unknown fields during configuration migration.
- Use temporary configuration directories in Python tests; never read the user's real runtime.
