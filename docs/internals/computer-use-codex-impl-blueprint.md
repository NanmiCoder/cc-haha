---
title: Codex Native Computer Use Compatibility Contracts
nav_title: Codex Compatibility
description: Verified contracts for the official plugin, native events, action timing, and batched observations, with current compatibility limits.
order: 15
---

# Codex Native Computer Use Compatibility Contracts

The macOS native Computer Use implementation uses the plugin, JavaScript client, and native service shipped with official Codex as its compatibility reference. This page describes verified call and event contracts so source readers can distinguish input delivery, observation, and model scheduling. Third-party replicas no longer define official behavior; similar interfaces or success on one task do not establish complete compatibility.

## Reference version and layers

These contracts come from the official build inspected on September 9, 2026:

| Component | Version or location |
| --- | --- |
| Computer Use plugin | `openai-bundled/unified-computer-use/26.901.51231` |
| Native service | `SkyComputerUseService`, version `26.831.1000926` |
| Native service SHA-256 | `25e9141499b94c396f39afbdb7b19ed8f49e45dc8c61be61028ceab8f3807ce6` |
| Plugin cache | `${CODEX_HOME}/plugins/cache/openai-bundled/unified-computer-use/<version>/` |
| JavaScript packages inside the App | `Contents/Resources/cua_node/lib/node_modules/@oai/cua` and `@oai/sky` |
| Local native service | `${CODEX_HOME}/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService` |

These versions define the scope of the contracts. Recheck both caller and implementation after upgrades. Native function addresses apply only to this binary; detailed evidence lives in `native/cu-helper/README.md` in the source tree.

Native App operations follow this path:

```text
A cua App object in a persistent JavaScript session
  → @oai/cua / @oai/sky client
  → persistent local IPC
  → SkyComputerUseService
  → AX queries or events targeting a process and window
```

The browser Tab provider is a separate path. Having a browser extension installed does not mean every Chrome action uses the DOM: a native App object obtained through `cua.getApp(...)` can send coordinate clicks and drags directly. Identify the execution mechanism from the actual object, method, and transport used.

The macOS native App path permits control of browsers such as Chrome while retaining other application restrictions, authorization, signature, and process-identity checks. Previously, both TypeScript dispatch and native `AppTargetPolicy` rejected targets solely because they were browsers, blocking this valid native route. Both layers now apply the same native-browser policy. Windows keeps its existing browser category and permission tiers. Allowing a browser as a native App does not supply Tab bindings, DOM nodes, or Playwright methods.

The designated successful Townscaper trace illustrates this distinction. Its 21 JavaScript calls begin with browser inventory and a timed-out `getTab`, then bind the native Chrome App. All 57 input actions use that App: 47 drags, 3 clicks, 3 scrolls, 3 key presses, and 1 paste, with 18 screenshots returned. Six cells containing loops execute 41 drags: 39 inside loop bodies and 2 palette actions outside them. There are no successful Tab, DOM, or Playwright construction calls. This case's consecutive construction actions use the native App path; the independent browser provider is outside this compatibility scope.

The public Codex CLI and App Server source includes MCP integration, tool dispatch, and message handling, but not this native service's mouse-event implementation. The official installation provides readable JavaScript clients; native contracts also require checking exported symbols, actual call arguments, and machine code. Missing CGEvent symbols in a static import table do not prove an AX-only implementation: the service also sends events through dynamically resolved function pointers.

## App discovery and native APIs

Native application restrictions match the official 24 forbidden bundle IDs exactly, in addition to this product's host and helper identities. Legacy IDE, music, trading, and display-name substring categories no longer determine macOS native access. Discovery can include forbidden targets; binding and actions still enforce authorization.

`cua.listApps()` combines regular running Apps with Spotlight Apps used in the last 14 days, preserving `id`, `displayName`, `isRunning`, and optional `lastUsedDate` and `useCount`. The bundle-based `id` is distinct from a resolved App path. Structured inventory crosses the helper, dispatcher, and worker intact, with compatibility for older helpers that only report running Apps. The 11 snake_case native window methods are also available through `cua.computer`, using the same authorization and process checks.

## The five-event coordinate drag contract

Official `app.drag()` passes its origin and optional drag destination through the native coordinate controller to `ApplicationUIElement.sendClick`. The underlying `SynthesizedEvent.click` creates these events, with one window binding throughout the gesture:

| Order | Event | Location | clickCount | eventNumber |
| --- | --- | --- | --- | --- |
| 1 | mouseDown | Origin | 1 | Gesture number |
| 2 | mouseDragged | Origin | 0 | Motion number |
| 3 | mouseDragged | Midpoint | 0 | Same motion number |
| 4 | mouseDragged | Destination | 0 | Same motion number |
| 5 | mouseUp | Destination | 1 | Same gesture number |

Zero-distance drags retain all five events and must not collapse into ordinary clicks. The initial dragged event at the origin must also remain. Ordinary click pairs and drag motion events have different semantics; an arbitrary interpolation count is not a substitute for this contract.

The native service constructs mouse events through AppKit, obtains their CGEvents, assigns target-window information and global/window-local positions, then posts to the target PID. This is neither AXPress alone nor foreground clicking after moving the user's real pointer. Coordinate conversion, window identity, and process lifetime must agree throughout the path; similar window titles cannot establish a screenshot/input binding by themselves.

The corresponding implementation is concentrated in `native/cu-helper/Sources/cu-helper/AXAction.swift`, `WindowTargetedEvent.swift`, and `WindowGeometry.swift`. `MouseDragEventTests` uses the production event factory to verify order, coordinates, event numbers, and window binding.

## Keyboard input

A native receiving window verified the actual modifier events for `Control_L/R`, `Super_L/R`, `Meta_L/R`, `Shift_L/R`, and `Alt_L/R`. `Delete` maps to forward-delete keyCode 117 and `BackSpace` to 51. Uppercase letters and named symbols such as `question` retain Shift. Both the parser and system-key grant checks recognize these aliases.

## Scroll pages and target regions

Official native `scroll` sends precise pixel wheel events and preserves fractional pages. Indexed vertical scrolling multiplies pages by the target element's outer frame height. Coordinate scrolling uses the current window height, not the scroll area under that point. In the same 210-point-high scroll area, indexed requests for 0.5 and 1.5 pages produced deltas of -105 and -315. In its 552-point-high window, a coordinate request for 0.5 pages produced -276, or +276 when scrolling up. These requests must not become rounded whole-page AX actions or a fixed 12-line wheel conversion. Explicit `performSecondaryAction` calls such as Scroll Down retain the control's exposed AX page-action semantics.

The inspected official version creates a single-axis wheel event for horizontal requests, and receiver measurements confirmed that horizontal deltas were ignored. This implementation retains working two-axis horizontal scrolling. That is a documented behavioral difference rather than a reproduction of the ineffective action.

Wheel events also carry window fields 51, 91, and 92 and window-local coordinates. Fields 91 and 92 alone do not establish AppKit's `windowNumber`, allowing event construction to succeed while the receiver gets nothing. Actual receiver tests verified precise scrolling after adding field 51. Noninteger distances round to the nearest integer; for example, 210 × 0.123 points produces a 26-pixel delta.

For its four page directions, `performSecondaryAction` first reads `AXVerticalScrollBar` or `AXHorizontalScrollBar`. It searches the scrollbar's `AXChildren` in order for the first `AXButton` with subrole `AXDecrementPage` (up/left) or `AXIncrementPage` (down/right), then performs `AXPress`. Only a missing scrollbar or button falls back to the target's raw `AXScroll*ByPage` action. A failed button press propagates without replay. `AXIncrementPage` and `AXDecrementPage` are subrole values, not queryable attribute names. The control determines the page distance; no pixel distance is hardcoded.

## Paste consumption and timing

The native paste operation's two seconds are a read timeout, not a mandatory delay. Before writing temporary content, it captures supported `AXSelectedTextRange` and `AXNumberOfCharacters` values from the target process's focused element and observes that element's selection and value changes. Notifications become armed after the write. A successful promised-data supply ends the first stage early.

The second stage checks the target every 25 milliseconds for at most two seconds. A target notification after data supply or a valid attribute change permits early completion. Another clipboard observer's read alone does not establish target consumption, and a failed AX read is not a changed value. With no observable signals, the operation retains a 100-millisecond window after the read. With signals but no observed change, it reports a target-confirmation timeout and never replays the paste. Cancellation still drains the bounded consumption window before restoration. External copies always win; the previous clipboard is restored only while the temporary content remains owned.

The deterministic receiver regression uses a separate named pasteboard while retaining the real Router, Command-V, menu, data provider, target AX confirmation, and restoration. It isolates the shared data source and does not establish general-clipboard behavior in every environment.

## Screenshot size and format

Official native state capture normalizes to logical point dimensions, then caps the long edge at 2048 and the short edge at 768 without upscaling. Output pixel dimensions are rounded up, with JPEG quality 0.8. A 1398 × 769 point window therefore produces 1397 × 768 pixels. This difference is scaling, not edge cropping. Coordinate conversion retains the complete window frame and the uniform pre-rounding `pixelsPerPoint` scale rather than deriving separate axis scales from rounded dimensions. Older snapshots without the uniform scale keep the previous conversion.

The native result's `mimeType` follows image data across dispatch and the worker. Older helpers without this field remain PNG-compatible. The official wrapper has labeled actual JPEG bytes as PNG; this implementation keeps the correct JPEG MIME label so downstream model requests can interpret the content correctly.

## Action timing and the visible cursor

The inspected coordinate click and drag calls explicitly pass `delay: nil`. Both direct and virtual-cursor senders skip their optional sleep. There is therefore no fixed 30 ms delay per event or fixed 100 ms button hold on this path. The service's `humanClickInterval` constant belongs to other explicit click or press paths and must not be applied to coordinate drags.

The virtual-cursor branch updates pressed state synchronously and posts events. The coordinate click/drag path does not wait for a cursor movement animation to complete before sending input. Dedicated `moveMouse` operations have their own animation and next-interaction timing on a different path. Cursor feedback should remain visible without adding an unconditional visual delay to every coordinate gesture.

The machine code contains Swift executor transitions, which do not guarantee a suspension or a specific interval between events. Adding a guessed sleep or `Task.yield` would not reproduce a verified contract. This implementation removes confirmed artificial waits while retaining target validation before delivery, cancellation checks, and button-release cleanup after errors.

Focus preparation must also remain separate from visual timing. `SyntheticWindowFocus` preserves process-lifetime, focus-change, and input-acknowledgement checks. Established focus can be reused; acknowledgement waits apply when focus actually needs to be established or restored. Removing all focus checks is not a compatibility optimization.

## Batched actions and observations

The official native App API can retain App bindings, compute coordinates, and loop over actions in a persistent JavaScript session. One tool call can perform several known actions before reading AX state or taking a screenshot. `await app.drag()` inside that loop waits for a local action; it does not require a new model response between gestures.

The native coordinate controller enters UI settling and capture only when `returnSkyshot: true`; false marks state for refresh and returns. The verified settle call includes a 250 ms notification-delay parameter. This is neither an unconditional 250 ms sleep after every action nor a promise about total capture time. Automatically taking a new screenshot after every mutation is not a fixed official contract.

On macOS, only `js` and `js_reset` are advertised to the model, reducing duplicated per-action schemas. `js` supports persistent variables and App bindings, top-level `await`, loops, calculations, and observations within a call. The worker's native `cua` App methods send JSON messages to the host and enter the existing semantic tools' permission, process-identity, and window checks. A script's App object cannot bypass those checks. `cua.getApp()` displays initial AX text; the first visible App selection or inventory also includes brief API guidance. App bindings use the resolved path returned by the host, and subsequent actions still validate the target again.

`app.getAXState()`, `app.getScreenshot()`, and `app.getAXStateAndScreenshot()` return and display text, an image, or both. `emit: false` preserves the return value while suppressing display. The inspected official JavaScript implementation also maps all three methods to `get_app_state`, so output selection does not imply skipping AX traversal or capture. Actions do not automatically observe; scripts explicitly request state at the next decision point.

Underlying element handles remain `gN:id`. The facade maps only AX rows actually returned to the caller to integer indices, applies additions, changes, and removals from diffs, and clears old mappings when the generation changes. Image-only requests can refresh native state and therefore clear integer mappings. Call `app.getAXState({disableDiffing: true})` before using integers again. Copied opaque handles still pass through native validation.

| Limit per `js` call | Value |
| --- | --- |
| Native calls | At most 256, including observations |
| Code | At most 256 KiB |
| Displayed output | At most 128 blocks and 16 MiB in total |
| Timeout | 30 seconds by default, at most 60 seconds |

Shared lexical accessors connect variables across cells, so older functions and newer scripts read the same binding. Previously defined functions use the new App after rebinding. A function may also refer to an App declared in a later cell. Local parameters, block scopes, destructuring, and class-local bindings retain their own semantics; copying variable values into each new cell cannot provide this persistence.

Ordinary script errors retain recoverable existing bindings and declarations or direct writes that executed. Unreached `var/function` declarations in a failed cell do not leave extra bindings merely because they are hoisted. When an App replacement initializer fails, the previous App binding remains available. `js_reset`, cancellation, or timeout discards the worker and its bindings. Completed actions are not rolled back: bind again and observe before deciding how to continue partially completed work. Imports, Node, filesystem, and networking APIs are currently unavailable. Execution and isolation boundaries live in `src/utils/computerUse/replRuntime.ts`, `replWorker.ts`, and `replCompiler.ts`; native method and observation-output adaptation lives in `src/vendor/computer-use-mcp/replApi.ts`.

Native errors with proven equivalents retain the `SkyComputerUseError` name, code, errorName, and request fields. Unmapped helper errors retain their original `nativeCode`; messages are not used to guess official codes. Permission or argument refusals before dispatch increment `nativeCallsRejectedBeforeDispatch` and are not reported as completed actions or unknown execution results. Timeouts and errors with possible partial effects remain result-unknown and are never automatically replayed.

The desktop uses a merged sidecar executable. It must recognize the internal worker argument before parsing ordinary modes or `app-root`, or loading `preload`, and start the isolated kernel directly. Handling the argument only in the CLI sub-entrypoint makes the actual desktop executable fail earlier; source-worker or handwritten compiled-entrypoint tests cannot cover this boundary. The worker's HOME and temporary paths point to disposable directories. Temporary-directory variables are set again inside the sandbox so the wrapping library cannot replace them.

The existing `sequence` remains a compatible JSON batch entry point for one App. It executes serially, observes once at the end, and reports completed steps after failure or cancellation. It accepts at most 256 steps and uses a cooperative 60-second deadline; an in-flight native command must finish before the runner returns. Standalone semantic tools also retain direct-call compatibility, but these interfaces are no longer advertised to the model by default. Windows continues using its existing pixel tools without these JavaScript interfaces.

Whether batching is appropriate depends on interface stability. Known canvas actions can run consecutively; opening menus, changing windows, or otherwise changing subsequent targets creates a new decision point that needs observation. Measure action counts, observation counts, model round trips, tool duration, and receiver-visible results separately.

## Current compatibility limits

Event-factory tests verify the five-event construction. The integration tests that sent repeated drags to a disposable native app have been removed so ordinary tests do not open windows or operate the macOS desktop. Gesture delivery to real apps requires separate manual verification; factory tests do not establish success rates for Townscaper, Blender, or all real tasks.

Targeted process-identity regression runs passed all 15 rounds: 45 disposable Apps, 180 complete drags, and 1,095 samples from actual validation calls. Identity fields and launch-time floating-point bits remained unchanged within each process. Two earlier anomalies—a `stale_process` rejection and a timeout without phase records—did not recur and remain unexplained. Identity comparisons were not relaxed, and no tolerance or automatic retry was added. `ProcessValidationObservationTests` retains regression coverage for identity diagnostics; the real-input results above are historical evidence from the removed tests.

The compatibility scope is native Computer Use. Independent browser Tab and DOM providers and general Node capabilities are outside this scope. Tests of the real worker child process use temporary directories and simulated native tools to establish isolation, persistence, and output boundaries; native receiver tests establish event delivery. Neither replaces success-rate evaluation on real model tasks or establishes behavioral parity across all real Apps.

AX rendering, element relocation, focus, keyboard input, window coordinates, capture, and cursor animation each have their own contracts. This page does not prescribe speculative algorithms or third-party constants for unverified areas. Further compatibility work should establish evidence along the actual call path, then encode confirmed behavior in the corresponding source and regression tests.
