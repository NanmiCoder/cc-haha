---
title: Computer Use Architecture
nav_title: Computer Use
description: The macOS native engine, Windows/Linux agent-desktop integration, sessions, and input boundaries.
order: 12
---

# Computer Use Architecture

Computer Use exposes interface observation and desktop actions to the Coding Agent through a built-in MCP server. macOS keeps its existing JavaScript session and Swift `cu-helper` engine; Windows and Linux use a pinned copy of Vercel Labs `agent-desktop`. Start with the [user guide](../desktop/computer-use.md) for setup.

## Call paths

```text
Model / MCP client
  → setup.ts: platform, native binary, global enablement
  → MCP schema and wrapper.tsx: arguments, cancellation, current agent context
  → product Computer Use session lock
      ├─ macOS: JS / AX tools → cu-helper daemon → AX / targeted input / window capture
      └─ Windows / Linux: desktop tool → agentDesktopBridge → agent-desktop CLI
                                                    ├─ Windows: UI Automation
                                                    └─ Linux: AT-SPI / X11 / Wayland capabilities
```

`setupComputerUseMCP()` registers tools only on supported platforms when the relevant binary resolves. The Settings API additionally performs a real native status probe: Windows/Linux return `engine: "agent-desktop"`, `runtime: "agent-desktop"`, and an `agentDesktop` status. A missing binary, denied accessibility service, or unresponsive Linux bus must not appear ready. Ready means the runtime is available, not that every command or app is supported.

Desktop sessions refresh the Computer Use tool list before each turn. When the user explicitly requests Computer Use, the CLI checks the final tool list before sampling the model. An unavailable tool produces a specific error. When the tool is available, the turn uses native tools for desktop actions.

## One application authorization boundary

Enabling Computer Use in Settings and confirming its consent dialog authorizes all supported apps. Runtime calls do not add per-app prompts, application allowlists or denylists, or `read/click/full` permission tiers. Global disablement, OS permissions, and target-process/window validity still apply.

`computer-use-config.json` preserves historical `authorizedApps`, `grantFlags`, `pythonPath`, and unknown fields instead of overwriting user configuration. Historical application records do not define another authorization boundary. Windows/Linux production entry points no longer detect or install Python; `/setup` returns a native-runtime explanation. macOS continues to use its native permission card for Accessibility and Screen Recording.

## The macOS engine remains separate

The persistent macOS JS tool runs in an isolated child process and exposes `cua.getApp()`, App actions, and AX/screenshot reads. Native calls enter `native/cu-helper/` through an authenticated NDJSON daemon connection.

- Elements are resolved again using snapshot/window epochs, semantic fingerprints, and process identity, so an old index cannot silently bind to a new interface.
- Actions prefer AX behavior. Synthetic events use `CGEvent.postToPid` and window targeting without moving the physical pointer or posting into the global HID input stream.
- Synthetic focus lets background apps accept input. A foreground lease detects human interference and restores foreground only when evidence permits it after a target takes focus; it does not blindly retry.
- Capture binds the window, process identity, and coordinate transform. ScreenCaptureKit streams handle covered windows; cached pixels are not treated as fresh evidence when freshness cannot be established.
- The system clipboard remains shared. The paste path backs up content and uses a change-count guard. A user editing the same app can still interfere with the result.

This path calls neither `agent-desktop` nor a Python fallback.

## One desktop tool for Windows/Linux

`buildAgentDesktopTools()` exposes one MCP tool rather than turning CLI commands into 60 separate MCP tools:

```json
{"command":"snapshot","args":["--app","APP","-i"]}
```

`command` accepts the pinned upstream version's complete **60 command names**: observation, ref actions, keyboard/mouse, apps/windows, notifications, clipboard, wait, batch, session, trace, status, permissions, and skills. An available command name does not imply platform support for its action; held-input commands, for example, explicitly refuse under upstream rules.

Before acting, load the embedded instructions through the same tool:

```json
{"command":"skills","args":["get","desktop"]}
{"command":"skills","args":["get","platform"]}
```

`args` is an argv string array, never a shell command. The host manages `--session`, `--agent-id`, trace paths, and image output paths. Callers request physical input for a command with `headed: true`; they cannot override host identity. `batch` runs entries in order through the same command and policy checks; it is not a transaction.

Preserve complete refs from observations, such as `@s8f3k2p9:e1`. Actions check live identity again; `STALE_REF` and `AMBIGUOUS_TARGET` call for another observation. Bare `@e1` is invalid, and snapshots from another native session cannot be borrowed.

### Headless behavior and side effects

The default headless policy lets supported semantic ref actions run without moving the physical pointer and refuses actions needing disallowed physical input. It still requires a usable graphical user session. It is not a side-effect-free switch for every command.

| Path | Actual behavior |
|---|---|
| Windows semantic refs | Use UIA Invoke, Value, Selection, Toggle, and similar patterns. Standard WinForms buttons and text fields use LegacyIAccessible for background clicks, value writes, and clears to avoid the Windows proxy's focus change |
| Windows `type`, right-click, multiple clicks, focus | Require `headed: true`; `type` uses `SendInput`, not background per-process keyboard delivery |
| Linux headless refs | AT-SPI semantic actions work on X11 and Wayland, subject to control capabilities and live identity |
| Linux headed refs | `click`, `right-click`, and `type` try physical input first; semantic fallback is possible only after a supported refusal that proves no input was delivered |
| Linux physical pointer | Ordinary apps require X11 and share the real pointer; Wayland explicitly refuses. Some Wayland keyboard paths depend on Mutter RemoteDesktop capabilities |
| Bare `press`, `focus-window`, clipboard | Can send keys to the foreground, change foreground, or access the shared clipboard without headed; scoped press additionally verifies foreground ownership |

Restore minimized Windows windows before observing and acting. `focus-window` takes foreground and should not be a routine prerequisite for background actions. Linux Wayland has extra window/capture limits: native windows cannot be moved or focused through X11 APIs, screenshots use a portal and may need a person's consent, and clipboard operations need `wl-clipboard`. X11 capture also depends on the compositor; full-screen capture is not universally available.

Keep JSON envelope delivery, retry, and verification information. Unverified delivery, partial input, timeouts, and cancellation may leave an unknown result. Observe the current state before continuing; `ok` or an input dispatch alone is not a reason to replay a business action.

## Sessions, traces, and per-agent cursors

The bridge redirects `AGENT_DESKTOP_HOME` beneath the product config directory. On Windows, the native engine creates `.runtime/agent-desktop-private/` with a private DACL. Linux uses `.runtime/agent-desktop/`. The Windows readiness probe verifies that it can write, read, and clean up a file in session storage. Settings shows the reason if the probe fails. The first operation needing a session creates a host-owned native session and configures multi-agent cursors. Eligible actions start the renderer on demand.

Business commands retain the calling Agent's async `getCwd()` context, so relative image and file paths resolve in that working directory. `AGENT_DESKTOP_HOME` controls state independently. Every native process dispatch rechecks saved global consent, including the actual action after session initialization and cursor configuration. Revocation still permits necessary resource cleanup.

Each product session maps to a native session. The host passes distinct `agent-id` values for the main agent and subagents, with stable hashes for invalid names. Native session namespaces scope snapshots and traces. Treat traces as user data because they can contain interface and action details. Images are read from a bounded host artifact directory and delivered as MCP images. Native trace export remains available.

Windows positions the cursor in physical pixels and scales the arrow and label to the monitor's DPI. The host sets the in-turn idle fade delay to 45 seconds. The renderer acknowledges arrival after submitting the destination frame to the Windows compositor and returns a warning if the paint fails. Linux X11 displays a static arrow at action positions. The `cursor_overlay` field in action results reports configuration, renderer acknowledgement, and warnings separately. Input devices and the clipboard remain shared.

The existing product `computer-use.lock` remains owned by product session. Only one product session holds it at a time, and turn completion or cancellation releases it. Main agents and subagents in one process share the binder, retain their own async context, and run through its queue. Upstream interaction leases additionally coordinate native actions. Agent identity and multiple cursors do not mean independent desktops can be written concurrently.

Turn cleanup disables the native cursor. A teardown failure or timeout marks the host state unknown so the next action reconfigures it. Process shutdown cancels active native commands and ends every native session it owns, including sessions created before a product session switch. The session Stop button and CLI Ctrl+C propagate cancellation. POSIX cancellation preserves the upstream two-second input release budget and waits for the child to exit before advancing the queue. The current host does not provide a guaranteed global Escape shortcut across applications.

## Build and distribution

The pinned source is Vercel Labs `agent-desktop` **1.0.2**, commit `9eb9b296192fcb70bda25e918cd6dd66abfa3d0d`. `native/agent-desktop/UPSTREAM.json` records the revision and original copied-file hashes; `PATCHES.md` records local changes such as the product cursor shape.

Prepare the stable Rust toolchain, target standard library, system linker dependencies, and locked Cargo cache before the offline build. Initial cache preparation can use:

```sh
cargo +stable fetch --locked --manifest-path native/agent-desktop/Cargo.toml
```

Build on the matching platform runner. For a Linux x64 development build:

```sh
bun desktop/scripts/native-agent-desktop.ts --target-triple x86_64-unknown-linux-gnu --debug
```

`desktop/scripts/build-sidecars.ts` integrates the script, builds with `cargo +stable build --locked --offline`, and stages the CLI under `desktop/src-tauri/binaries/`. Linux also requires `agent-desktop-linux-clipboard-owner` beside the CLI; Windows uses `.exe`. macOS packaging continues to build the Swift helper. Generated binaries, Cargo targets, and manifests are not committed.

The development resolver can read the source tree's Cargo targets; the packaged resolver reads the app's binaries directory. Electron places these files in `app.asar.unpacked`, with `LICENSE`, `NOTICE`, `THIRD-PARTY-NOTICES`, `UPSTREAM.json`, and `PATCHES.md` under `agent-desktop-licenses/`. Original upstream code remains licensed under Apache-2.0; the root Community Source License does not narrow those existing rights. Dependencies keep their own licenses. Distributing an executable alone does not replace the required notices.

## Source entry points

| Path | Responsibility |
|---|---|
| `src/utils/computerUse/setup.ts`, `common.ts`, `gates.ts` | Platform capabilities, binary gate, tool registration |
| `src/vendor/computer-use-mcp/mcpServer.ts`, `src/utils/computerUse/wrapper.tsx` | Session binding, async context, cancellation, product lock |
| `src/vendor/computer-use-mcp/agentDesktopTools.ts`, `agentDesktopProtocol.ts`, `agentDesktopDispatch.ts` | Single MCP tool, complete command schema, queue |
| `src/utils/computerUse/agentDesktopBridge.ts`, `agentDesktopBinary.ts`, `agentDesktopProcess.ts`, `agentDesktopResult.ts` | Native sessions, resolution, bounded child processes, image delivery |
| `native/cu-helper/` | macOS AX, targeted events, focus, window capture |
| `native/agent-desktop/` | Pinned upstream Rust workspace and platform implementations |
| `src/server/api/computer-use.ts` | Runtime status, global config, macOS permission-card API |
| `desktop/src/pages/ComputerUseSettings.tsx` | Platform status, global enablement consent, recovery guidance |

Regression tests use temporary config directories, fake runners, or loopback transports to prove argument, state, and result boundaries. They must not use a person's desktop, live providers, or user configuration as fixtures. Platform smoke tests are separate evidence; macOS compilation or mocks do not establish Windows/Linux input behavior.

Session identity belongs to the host. Run explicit `session start` / `session end` as standalone calls; lifecycle changes inside `batch` are rejected so later commands cannot retain an ended session or orphan a cursor.
