# Computer Use redesign — handoff context (for starting from scratch in a new worktree)

> Companion documents (same directory, take them along):
> - `computer-use-codex-redesign.md` — architecture comparison + redesign spec + adversarial audit (root causes of why it is slow / clunky / inaccurate)
> - `computer-use-codex-impl-blueprint.md` — **the authoritative implementation spec** (exact skyshot text format / traversal / injection ladder / tool surface / staleness / screenshots / per-app)

---

## 1. What this is / goal

Build native macOS **Computer Use** (letting the model drive local apps) for the Electron desktop app **"cc-haha"** (a fork of Claude Code; the desktop app is **Electron 0.4.0**, not Tauri).

**Core goal = a faithful replica of Codex's Computer Use: ① easy to use ② every feature replicated ③ fast.** No compatibility shims or patch code; everything from the interface layer to the helper layer may be redesigned.

Current state: the old implementation is a blind loop of **"full-screen screenshot → model eyeballs pixels → synthesized event at coordinates"**, which is slow, injects unreliably and captures inaccurately. It needs to become Codex's **"read the AX tree → click semantically by element index"**.

---

## 2. Core architectural judgment (why Codex is good)

| | Codex (good) | Old implementation (bad) |
|---|---|---|
| Perception | **`get_app_state`**: **AX tree + window screenshot** of the key window, once per turn, sends diffs | Full-screen screenshot, re-captured after every action |
| Targeting | Semantic click by **AX element index** (or pixel fallback) | Full-screen pixel coordinates only |
| Injection | **Pure AX** (`AXUIElementPerformAction`), does not steal the mouse or rely on focus | `CGEvent.postToPid` pixels, unreliable on Electron |
| Transport | XPC | socket + NDJSON + base64 images |

**Root cause in one sentence: Codex is driven semantically by the AX tree; the old implementation is blind screenshot-and-pixel operation.** Fixing this one thing fixes slow / clunky / inaccurate at once.
**The crux (the single core uncertainty): does AX work on Electron/Chromium?** — the target app needs `AXEnhancedUserInterface`/`AXManualAccessibility` turned on to force the AX tree to be exposed. Codex does this (proven) and so will we, but it is **not verified on a real device** — the first thing to do in the new worktree is verify this on real hardware.

---

## 3. Target interaction (what it should look like)

**The model's control loop (= Codex's loop):**
```
get_app_state(app)  ── returns {AX tree text (clickable elements with index) + screenshot of that window} ──▶ model
       ▲                                                                        │
       │  automatically re-snapshot get_app_state after each action (model need not re-query)  ▼
       └────────────────  click(index)/set_value/type_text/scroll/...  ◀────────┘
```
- **One get_app_state per turn**, then several semantic actions; each action returns = an automatic fresh snapshot.
- 9 tools (verbatim): `list_apps, get_app_state, click, perform_secondary_action, set_value, scroll, drag, press_key, type_text`.

**Visual interaction (what the user sees; replicate Codex's "visible but never grabbing"):**
1. **Virtual cursor**: an animated cursor on screen glides smoothly from A to B (ease/spring); it is **not** the real mouse (the real mouse never moves). It should look good (Codex has a polished synthetic cursor). **It must not block actions** (the old implementation awaited the glide inside the click path, wasting up to 0.5s per click).
2. **Tinted border around the controlled window**: a soft glowing border around the outer edge of the app window being operated, **following the window as it moves and disappearing when it hides** (driven by AX observers). Brightness should be gentle (no harsh flicker).
3. **Authorization card**: when permissions are missing, show a native card (Accessibility + Screen Recording) with one-click authorization + drag into System Settings + live status turning green (copy Codex's onboarding card).
4. **(Codex has these, optional)** per-app authorization prompt (MCP elicitation), confirmation policy (blocking confirmation for dangerous actions), menu bar "Stop / Controlling".

> There are no interaction screenshots at hand; **the best "interaction reference" is Codex itself** — open Codex, run Computer Use once, and record/screenshot its virtual cursor + tinted border + authorization card + get_app_state output, then build to match.

---

## 4. Codex implementation reference paths (inspectable locally)

**Plugin directory**: `/Applications/Codex.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use/`
- `skills/computer-use/SKILL.md` — tool contract + **the full confirmation policy** (four tiers: Hand-Off / Always-Confirm / Pre-Approval / No-Confirm).
- `.mcp.json` — MCP server = `SkyComputerUseClient mcp` (stdio) → connects over XPC to the background `SkyComputerUseService`.
- `Codex Computer Use.app/Contents/MacOS/SkyComputerUseService` — **the privileged service** (AX + screenshots + injection). Dig out symbols with `nm -u` / `strings`: get_app_state semantics, pure AX injection (`_AXUIElementPerformAction/_AXUIElementSetAttributeValue`, zero CGEventPost), accelerated window screenshots (`Capture Accelerated Window Screenshot`/`additionalScreenshotWindowIDs`), AX tree construction, TurnEnded (`CodexTurnEndedNotification`), elicitation.
- `Codex Computer Use.app/Contents/SharedSupport/`: `SkyComputerUseClient.app` (MCP front end, XPC=`ComputerUseIPCXPCTransport`), `CUALockScreenGuardian.app` (lock screen / physical input takeover / SSRF), `Codex Computer Use Installer.app` (AuthorizationPlugin).
- `.../Resources/Package_ComputerUseClient.bundle/Contents/Resources/AppInstructions/*.md` — **per-app instructions (OpenAI copyright; study the format only, do not copy)**.
- `.../Package_ComputerUse.bundle/Contents/Resources/Skysight{Summarizer,MemoryInstructions}.md` — prompts for the Skysight memory subsystem.

**Codex app source**: `/Applications/Codex.app/Contents/Resources/app.asar` (143MB, `bunx asar list/extract`) — see how the client drives the service, and the UX.

**Signing facts**: the whole Codex chain is Developer ID + notarized (TeamID `2DC432GLL2`). Our helper is Apple Development (not notarized) — **enough for local use; notarization is only needed for external distribution / a standalone XPC service (requires a paid Apple account, which the user does not have yet)**.

---

## 5. Open-source projects worth referencing (all have reverse-engineered Codex; re-clone into /tmp first)

| Repository | Language | License | Use |
|---|---|---|---|
| **`github.com/iFurySt/open-codex-computer-use`** | Swift | **No license = all rights reserved; read-only reference, do not copy code** | `docs/references/codex-computer-use-reverse-engineering/` (reverse-engineered architecture + **`tool-call-samples-2026-04-17.md` = real Codex get_app_state output; the renderer must assert against it verbatim**); `AccessibilitySnapshot.swift` = **format authority**; `ComputerUseService.swift` = injection ladder; `KeyMapping.swift`/`ToolDefinitions.swift` |
| **`github.com/OpenCodexLabs/open-codex-computer-use`** | Swift | **MIT (may borrow, with attribution)** | Same MCP-NDJSON transport; `AppState.swift` (traversal / staleness / (windowIndex,path) targeting), `UIElementService.swift` (injection), `WindowCapture.swift` (window-locked screenshots + SCK hang → screencapture fallback), `CodexCompat.swift` + `main.swift:768-810` (get_app_state envelope framing) + `:1517-1580` (**automatic re-snapshot after changes**), `AppGuidance.swift` (frameReliability) |
| **`github.com/vtomnet/codex-cua-tea`** | docs | OpenAI copyrighted content | `SkyComputerUseService.md` (tool surface / skyshot semantics), `AppInstructions/*.md` (per-app instructions verbatim, **format only**) |

> **IP discipline (the product has to ship):** write our own code that meets the spec; **do not copy Swift verbatim from any repository**. The skyshot text **format** is an interoperability protocol (matching it is fine); write the renderer **code** ourselves. AppInstructions content is OpenAI copyright; learn only the structure.

---

## 6. Key pitfalls / lessons (don't step on them again)

- **TCC dual-subject rule (proven by tracing tccd)**: the **Screen Recording** subject = the **outermost .app** on the path (helper embedded inside the host's app.asar.unpacked → subject = host → only the host can be authorized, or copy the helper to a standalone path so the subject is itself); the **Accessibility / injection** subject = **the process's own code identity = helper** (unchanged when nested). The two are independent.
- **Standalone install fix (option A, no notarization needed)**: on first run, **copy** helper.app from app.asar.unpacked **to `~/.claude/cu-helper/`** (self-written files carry no quarantine → no App Translocation), and launch it from that path with `open -n` → Screen Recording subject = helper itself. TCC matches by **certificate-based DR** (not path), so one authorization survives repackaging. (Implemented: `src/utils/computerUse/cuHelperInstall.ts`)
- **A hardened-runtime release .app cannot be exec'd bare from a shell** (SIGKILL); `open -n` is subject to **LaunchServices bundle-id de-duplication**; testing the daemon locally only works with the **bare debug-build binary** (not hardened), and it needs authorization to get AX.
- **A @MainActor closure running on a background DispatchQueue SIGTRAP-crashes the daemon** (`setEventHandler` is not @Sendable and inherits @MainActor) — AX stays on the main thread throughout, and background timer handlers must be explicitly `@Sendable`.
- **disclaim** (`responsibility_spawnattrs_setdisclaim`): bare-exec'd CLIs/cards use it to become their own responsible process; the daemon launched via `open -n` does not need it.
- **Never grab the mouse**: synthesized events only use `CGEvent.postToPid(pid)` + `.combinedSessionState`, **never** `.cghidEventTap`/`.hidSystemState`.
- **skyshot format details** (blueprint §1 has the full set): `App=bundleId (pid N)` / `Window: "t", App: App.` / `\t` indentation / humanized `kAXRoleDescription` (not AXRole) / `(traits)` / bare title / Description:/Help:/ID: (filter `_NS:`)/Value:/Secondary Actions: (pretty + denylist) / **no frame printed** / trailing `The focused UI element is …` / truncation at 160.
- **Electron key point**: without "generic container elimination / flattening + merging AXRows/AXContents", Electron's AXWebArea is thousands of empty wrappers that blow through the limit before reaching useful controls — "can't read the Electron tree" is usually this, not AX itself.

---

## 7. How far this worktree got (reusable / for reference / or tear it down)

Worktree `quizzical-lehmann-5ab084` contains an implementation that **compiles green + has its format verified against samples** (not verified at runtime; missing AX authorization):
- `native/cu-helper/Sources/cu-helper/`: `AXTree.swift` (get_app_state format + traversal + targeting + per-pid sessions), `AXAction.swift` (6-level injection ladder), `KeyMapping.swift`, `Capture.swift` (window locking + hang fallback), `AppGuidance.swift`, `CommandRouter.swift` (9 commands + staleness).
- `src/vendor/computer-use-mcp/`: 9-tool surface + get_app_state envelope + automatic re-snapshot (138 TS tests green).
- `src/utils/computerUse/cuHelperInstall.ts`: standalone install (option A).
- Crash fix: the @Sendable handler in `WindowFrameTracker.startPolling`.
- **Not done (peripheral)**: cross-layer TurnEnded protocol, MCP elicitation authorization, Skysight memory, Record & Replay, lock-screen guardian, XPC transport (phase 2, needs notarization).

A new worktree can either (a) take these 6 Swift files + the TS tool surface + cuHelperInstall.ts as a starting point, or (b) use only this document + the blueprint as the spec and write from scratch. **Either way, step one is verifying the crux on a real device (AX on Electron).**
