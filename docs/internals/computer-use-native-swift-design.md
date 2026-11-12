# Computer Use native design (Swift helper)

> Goal: replace the low-level execution layer, currently `pyautogui` (HID-level simulation that monopolizes the mouse), with a native Swift helper (PID-targeted injection + Accessibility + ScreenCaptureKit), to achieve **no hijacking of the user's mouse and keyboard** and **operating/capturing background windows**, in line with the Codex Computer Use experience.
>
> This is a **technical proposal / review draft**, with no production code. Decision points are listed at the end in "9. Open decisions".

Related docs: [Computer Use architecture deep dive](./computer-use.md) · [Feature guide](../desktop/computer-use.md)

---

## 1. Motivation and problem

The current implementation (see "5. Python Bridge" in the architecture doc) drives mouse/keyboard with `pyautogui`:

```python
# runtime/mac_helper.py
pyautogui.moveTo(x, y)          # moves the system's single real cursor
pyautogui.click(x=x, y=y, ...)
pyautogui.write(text, ...)
```

On macOS, `pyautogui` calls `CGEventPost(kCGHIDEventTap, event)` under the hood — it injects into the **hardware HID event layer**. Consequences:

1. **Monopolizes peripherals**: the system has a single physical cursor; injection drags it away, so the user cannot work at the same time;
2. **Global effect**: events land on "the current frontmost window / the window under the cursor" and cannot be targeted at a specific background app;
3. **Must be visible in front**: the window to click has to be frontmost.

This conflicts with the user's core need: **keep working yourself while the agent runs automation in another app (build / click / screenshot), without bringing that desktop to the front**.

---

## 2. How Codex does it (reverse-engineering evidence)

Running `otool -L` / `nm -u` / `strings` / `codesign` on `Codex Computer Use.app` yields the following facts (evidence in Appendix A):

### 2.1 Process topology

```
Codex Computer Use.app
├─ MacOS/SkyComputerUseService            main service (Swift, LSUIElement=true background agent without a Dock icon)
└─ SharedSupport/
   ├─ SkyComputerUseClient.app            the client that actually hosts MCP (.mcp.json points to it + the `mcp` argument)
   ├─ CUALockScreenGuardian.app           lock-screen guardian (detects physical input → fail-closed relock)
   └─ Codex Computer Use Installer.app    installer authorization plugin
```

- entitlements: `com.apple.security.application-groups` (sharing between processes) + `com.apple.security.automation.apple-events`.
- Auto-update: `SUFeedURL` points to OpenAI's appcast (updated independently of the main Codex app).

### 2.2 Three key capabilities = the root of not hijacking the mouse

| Capability | APIs used (binary evidence) | Effect |
|------|--------------------------|------|
| **PID-targeted injection** | `CGEvent*` + IPC `ComputerUseIPCAppPerformActionRequest` + `targetPID` | Events are delivered to **the target app process**, bypassing the global HID cursor |
| **Control-level operations** | `AXUIElementPerformAction` / `AXUIElementSetAttributeValue` / `AXUIElementCopyElementAtPosition` | Press buttons and set values directly, even in background windows; the string `Prefer simulating physical clicks over Accessibility actions.` shows CGEvent first, AX as fallback |
| **Virtual cursor** | `AccessibilitySupport.VirtualCursor`, `cursorPositionInScaledCoordinates`, `SkyLensView` + `Lens_frame_00~44.png` | Maintains its own logical cursor position and draws an **overlay "AI cursor (lens)"** for the user, instead of borrowing the real system cursor |

### 2.3 Screen capture

`ScreenCaptureKit` (`SCStream` + `ComputerUseIPCAppStartCaptureRequest`, with a capture animation overlay) — can capture **the layer surface of a specific window**, even when the window is not frontmost, is covered, or is on another Space.

### 2.4 Coexistence / lock-screen autonomy (advanced; not replicated in this proposal)

- `ComputerUseUserInteractionMonitor` + `userInteractionDebounceDuration`: detects real human input and backs off.
- `LockScreenPhysicalInputMonitor` / `SystemLockScreenOverlayPresenter`: can auto-unlock and take over fully while the screen is locked, and fail-closed relock as soon as physical input is detected. **Involves passwords and security; high risk; cut from v1.**

### 2.5 Conclusion

> The essence of Codex not hijacking the mouse = **PID-targeted event delivery + AX control operations + a self-drawn virtual cursor**; all three bypass "the system's single physical cursor". Using `kCGHIDEventTap` is exactly the opposite direction.

---

## 3. Key correction: macOS has no "free background desktop"

This must be stated clearly to avoid a misunderstanding of direction:

- macOS has **only one WindowServer / one GUI session** per machine; there is no Linux Xvfb-style headless second desktop.
- What "background / desktop not in front" really means:
  - **Screen capture** grabs window surfaces via ScreenCaptureKit → the window need not be frontmost;
  - **Injection** goes by PID / AX → the real cursor is not hijacked;
  - You **can** work in app B while it drives app A.
- **True full isolation** (independent desktops that don't interfere) is only possible on macOS via: ① a separate user account + fast user switching; ② a macOS virtual machine.
- Codex's lock-screen autonomy is a compromise of "you leave → fully automatic; you come back and touch something → back off and relock", not an isolated desktop.

---

## 4. Target architecture: replace only the bottom layer

Maximize reuse — **leave every upper layer alone and only swap the helper from Python to a Swift binary**.

```
┌─────────────────────────────────────────────────────────┐
│ Layer 1-4  MCP tools (24) · 9 safety gates · 191 app categories · permission UI │  ← fully reused, zero changes
├─────────────────────────────────────────────────────────┤
│ Layer 5    pythonBridge.ts — process call boundary                     │  ← a few lines: point at the Swift binary
├─────────────────────────────────────────────────────────┤
│ Layer 6    [old] mac_helper.py (pyautogui, HID level)                  │
│            [new] cu-helper  (Swift: CGEventPostToPid+AX+SCK)           │  ← the only new/rewritten part
└─────────────────────────────────────────────────────────┘
```

### 4.1 Replaceable boundary (confirmed)

The call shape at `src/utils/computerUse/pythonBridge.ts:159`:

```ts
execFile(pythonBinPath(), [helperPath, command, '--payload', JSON.stringify(payload)])
// parses stdout as { ok: boolean, result?: T, error?: { message } }
```

The Swift binary can be hot-swapped in as long as it follows **exactly the same protocol**:

```
cu-helper <command> --payload '<json>'
# stdout: {"ok":true,"result":...}  or  {"ok":false,"error":{"message":"..."}}
```

Replacement point: abstract `pythonBinPath()` + `helperPath` into `resolveHelperCommand()`, returning `["python3", mac_helper.py]` or `[cu-helper]` based on config/platform. Keep Python as a fallback / for non-mac platforms.

### 4.2 Command protocol (the full set the Swift side must implement)

Following the "command mapping table" in the architecture doc, the new implementation for each:

| Command | Old (pyautogui/mss) | New (Swift) |
|------|--------------------|-------------|
| `screenshot` / `zoom` | mss full screen | `SCScreenshotManager.captureImage` (display or window filter) |
| `click`/`double`/`triple` | `pyautogui.click` (HID) | `CGEventPostToPid(pid)` mouse events; optional AX `kAXPressAction` fallback |
| `type` | `pyautogui.write` (HID) | `CGEventPostToPid` keyboard events; text fields can use AX `setValue` |
| `key` / `hold_key` | `pyautogui.hotkey` | `CGEventPostToPid` with flags |
| `drag` / `mouse_down` / `mouse_up` | `pyautogui.dragTo` | `CGEventPostToPid` mouseDown→moved→up sequence |
| `scroll` | `pyautogui.scroll` | `CGEventCreateScrollWheelEvent` + `PostToPid` |
| `mouse_move` / `cursor_position` | `pyautogui.moveTo`/`position` | Only update the **virtual cursor** logical position + a mouseMoved event (drives hover) |
| `frontmost_app` / `list_*` / `open_app` | NSWorkspace/Quartz | Same (native `AppKit`/`CoreGraphics`) |
| `read_clipboard`/`write_clipboard` | NSPasteboard | Same |
| `check_permissions` | osascript+CGDisplayCapture | `CGPreflightScreenCaptureAccess` + `AXIsProcessTrustedWithOptions` |

> The key differences are only in **mouse/keyboard injection** and **screen capture**; the other commands just get native equivalents.

---

## 5. Key technical points

### 5.1 Event injection: from the HID layer to per-PID

The core is this single API replacement (pseudocode):

```swift
// Old path (pyautogui equivalent): inject at the hardware layer → hijacks the real cursor
CGEvent(...)?.post(tap: .cghidEventTap)

// New path: deliver to the target process → the real cursor does not move
let e = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown,
                mouseCursorPosition: pt, mouseButton: .left)
e?.postToPid(targetPid)   // CGEventPostToPid(pid, event)
```

- `targetPid` comes from `frontmost_app` / the authorized app's `NSRunningApplication.processIdentifier`.
- Click sequence: `mouseMoved → leftMouseDown → leftMouseUp`; multi-clicks via `setIntegerValueField(.mouseEventClickState, n)`.
- Coordinates still go through the existing `scaleCoord()` ("Coordinate system" in the architecture doc); no upper-layer changes.

### 5.2 Accessibility fallback

CGEventPostToPid is **not a silver bullet** for background apps (see §6.2), so provide an AX path for "buttons / menu items / text fields":

```swift
let app = AXUIElementCreateApplication(targetPid)
// hit-test the control at the coordinates
var elem: AXUIElement?
AXUIElementCopyElementAtPosition(systemWide, Float(x), Float(y), &elem)
AXUIElementPerformAction(elem, kAXPressAction as CFString)        // click
AXUIElementSetAttributeValue(elem, kAXValueAttribute as CFString, text) // set value
```

Strategy: **CGEvent first (closer to real interaction), AX fallback for failing/unreliable cases** (same as Codex).

### 5.3 ScreenCaptureKit background window capture

```swift
let content = try await SCShareableContent.current
let window = content.windows.first { $0.owningApplication?.bundleIdentifier == bundleId }
let filter = SCContentFilter(desktopIndependentWindow: window)   // or display
let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
```

- `SCScreenshotManager` on macOS 14+ suits single-frame "one per step" screenshots without a resident stream.
- Output is still encoded as JPEG/base64 and resized by the existing `imageResize.ts`; zero upper-layer changes.

### 5.4 Virtual cursor overlay (optional but strongly recommended)

Once the real cursor no longer moves, users cannot see where the AI is clicking → draw our own:

```swift
let win = NSWindow(...)
win.level = .screenSaver                 // or CGShieldingWindowLevel
win.ignoresMouseEvents = true            // do not intercept the user's real input
win.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
win.backgroundColor = .clear; win.isOpaque = false
// draw a cursor/lens icon inside that moves with the logical position (cf. Codex SkyLensView/Lens_frame_*)
```

### 5.5 Human coexistence monitoring (optional, v2)

```swift
NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDown, .keyDown]) { _ in
  // real human input detected → pause injection / debounce and yield
}
```

---

## 6. Risks and trade-offs (key to the decision)

### 6.1 Signing / TCC — the biggest hidden cost

- Computer Use needs two TCC permissions: **Screen Recording** + **Accessibility**.
- **For unsigned / ad-hoc signed binaries, every rebuild invalidates granted TCC permissions**, forcing repeated re-authorization during development, which badly hurts iteration.
- Stable authorization + distribution need Developer ID signing (ideally notarized too). This is the same **paid Apple signing wall** the project already knows (see memory: unsigned DMG distribution issues, signing as a prerequisite of the Electron migration).
- Mitigation: during development, pin a stable signing identity (even self-signed + manually trusted), and keep the helper as a long-lived standalone binary so rebuilds don't drag the main app's authorization along.

### 6.2 Expected controllability per app type (manage expectations)

| App type | CGEventPostToPid | AX | Expectation |
|----------|------------------|----|----|
| Native AppKit (Notes/Finder/System Settings/most third-party native) | Mostly works | Good | ✅ Reliable |
| Background **keyboard** input (non-key window) | Least reliable | Text fields via setValue are steadier | ⚠️ Needs AX fallback |
| Browsers (Safari/Chrome/Arc…) | Unreliable | Poor | ❌ Use Chrome MCP (existing deniedApps already downgrades to read-only) |
| Electron (VS Code / some apps) | Unstable | Incomplete | ⚠️ Verify one by one |
| Games / Metal / IOKit HID | Almost no response | None | ❌ Not supported |

> Codex writes `AppInstructions/*.md` for Notion/Spotify etc. and keeps a fully automatic lock-screen channel precisely because "every app works reliably" is not achievable and each app needs tuning. Our v1 only promises **mouse-free control of native AppKit apps**.

### 6.3 macOS single-session limit

See §3. "Background" ≠ an isolated desktop; true isolation needs a separate account or a VM, which is out of scope.

---

## 7. Phased implementation plan

| Milestone | Content | Acceptance | Estimate |
|--------|------|------|------|
| **M0** | TS-side `resolveHelperCommand()` abstraction supporting Python/Swift switching + a config switch | Switching to an echo Swift binary runs the JSON protocol end to end | 0.5 day |
| **M1** | Swift: `screenshot`/`zoom` (SCK) + read-only commands (frontmost/list/clipboard/permissions) | Screenshots match the Python version; permission detection is correct | 2–3 days |
| **M2** | Swift: `click` via `CGEventPostToPid`, **verify the real cursor does not move** | Clicks succeed in Notes/Calculator and the cursor does not move | 2–3 days |
| **M3** | `type`/`key`/`scroll`/`drag`/`mouse_down/up` | Typing/scrolling/dragging work in native apps | 2–3 days |
| **M4** | AX fallback (`kAXPressAction`/`setValue`/hit-test) | Controls where CGEvent fails succeed via AX | 2–3 days |
| **M5** | Virtual cursor overlay | The user can see the AI cursor position | 1–2 days |
| **M6 (optional)** | Coexistence monitoring and back-off | Pauses while a human is typing | 1–2 days |
| **Cut** | Lock-screen autonomy / Guardian / auto-unlock | — | Not doing |

Packaging: ship the Swift binary with `runtime/` (like `mac_helper.py`), or build it as a SwiftPM executable at build time. Mind the signing issue in §6.1.

**Total: core (M0–M5) about 2 weeks; M6 + tuning on top.**

---

## 8. Alternative: testing "your own app" has a lighter path

The user's original request included "**develop a desktop app → build → automated tests → automated screenshots**". For **an app you build yourself**, computer use (vision + blind clicks) is the wrong, heavy tool:

- **build**: `cargo tauri build` / `xcodebuild` — pure CLI, no computer use needed.
- **automated tests + screenshots**: this project is **Tauri**, so the right answer is **`tauri-driver` + WebdriverIO** (Tauri's official WebDriver) or **Playwright** directly against the WebView; the native shell can use **XCUITest**. These drive through **automation protocols**, **naturally never touch the cursor, can truly run in the background and in CI**, and are an order of magnitude more stable than simulated clicks.

> Rule of thumb: **computer use is for driving "arbitrary third-party apps with no API"; for driving "your own app", WebDriver/Playwright is better.** Both can coexist: self-testing via WebDriver, general control via the Swift helper.

---

## 9. Open decisions

1. **Scope**: should v1 be locked to "mouse-free control of native AppKit apps + background window screenshots", explicitly not promising browsers/Electron/games?
2. **Signing**: during development, do we accept pinning a self-signed identity with manual trust to keep TCC stable? Does distribution still use the existing unsigned script path (with the helper handled separately)?
3. **Pursue the alternative in parallel**: should we first get the most frequent need, "testing your own app", working quickly with tauri-driver/Playwright, and push the Swift helper as a mid- to long-term general capability?
4. **Virtual cursor / coexistence monitoring** in v1? (Recommendation: virtual cursor in v1, coexistence monitoring in v2.)

---

## Appendix A: reverse-engineering evidence (reproducible)

```bash
BIN="/Applications/Codex.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService"

otool -L "$BIN"        # → ScreenCaptureKit / ApplicationServices / CoreGraphics / AppKit / Carbon
nm -u "$BIN"           # → _AXUIElementPerformAction / _AXUIElementSetAttributeValue / _AXUIElementCopyElementAtPosition ...
strings -a "$BIN"      # → VirtualCursor / cursorPositionInScaledCoordinates / SkyLensView
                       #   ComputerUseIPCAppPerformActionRequest / targetPID
                       #   "Prefer simulating physical clicks over Accessibilty actions."
                       #   LockScreenPhysicalInputMonitor / CUALockScreenGuardian
codesign -d --entitlements - "$BIN"   # → application-groups / automation.apple-events
```

Key strings verbatim:
- `Enable the virtual cursor in Computer Use.`
- `Prefer simulating physical clicks over Accessibilty actions.` (original spelling)
- `Detected physical input during lock-screen Computer Use auto-unlock; relocking and suppressing auto-unlock until manual unlock.`

## Appendix B: anchors in our current implementation

- Call boundary: `src/utils/computerUse/pythonBridge.ts:159` (`callPythonHelper`)
- Executor: `src/utils/computerUse/executor.ts`
- Python helper: `runtime/mac_helper.py` (`click()` at :585)
- Upper layer (reused unchanged): `src/vendor/computer-use-mcp/` (tools.ts / toolCalls.ts / deniedApps.ts …)
