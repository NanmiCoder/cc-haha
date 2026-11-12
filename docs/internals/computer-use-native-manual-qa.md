# Computer Use native rewrite — on-device verification checklist

> This checklist covers only items that **automation cannot test and a real person must do on real hardware**.
> The automated parts (3000+ unit tests, 185 Swift tests, platform routing, fail-closed behavior, signing contract) are described in the commit notes and not repeated here.
>
> Prerequisite: `bash native/cu-helper/build.sh` produces an `.app`; or run `cd desktop && bun run build:sidecars`.

---

## 0. Preparation (redo after every reinstall)

1. Build the helper:
   ```bash
   bash native/cu-helper/build.sh
   ```
   Note the last line, `built: <path>`.

2. **Test authorization with the installed `.app`.** A re-signed debug binary has a new cdhash and TCC does not let it inherit any authorization — "I granted it but still have no permission" is almost always this.

3. Launch the daemon through LaunchServices, not a bare exec (a hardened-runtime release `.app` is SIGKILLed when exec'd bare):
   ```bash
   open -n "<built path>"
   ```

4. Confirm the signing identity has not rotated (rotation forces existing users to re-authorize):
   ```bash
   codesign -dv --verbose=4 "<built path>" 2>&1 | grep -E "Identifier|Authority"
   cat native/cu-helper/.build/.cu-helper.signid
   ```
   `Identifier` must be `dev.cchaha.cu-helper`.

5. **All three on the same certificate — the most common trap in packaged builds; check this before anything else.**

   The helper's client attestation (`ClientAttestation.swift`) requires the call chain to be cryptographically identifiable as this app: **host, sidecar and helper must be signed with the same certificate** (same team, same leaf), and the sidecar's identifier must be exactly `com.claude-code-haha.desktop.sidecar`. If any link does not match, the helper returns `unauthorized_client` for **every** command; the symptom is the settings page permissions stuck on "Checking…" and the authorization card not responding to clicks.

   ```bash
   APP="desktop/build-artifacts/macos-arm64/Claude Code Haha.app"
   B="$APP/Contents/Resources/app.asar.unpacked/src-tauri/binaries"
   for P in "$APP" "$B/claude-sidecar-aarch64-apple-darwin" "$B/cc-haha-computer-use.app"; do
     codesign -dv "$P" 2>&1 | grep -E "^(Identifier|TeamIdentifier)="
   done
   ```

   Expected: all three `TeamIdentifier` values identical, with identifiers
   `com.claude-code-haha.desktop` / `com.claude-code-haha.desktop.sidecar` / `dev.cchaha.cu-helper` respectively.

   Ad-hoc builds (`SIGN_BUILD=0`, or no signing certificate on the machine) **have no certificate at all, so Computer Use can never work on them** — this is not a bug, it is an inherent precondition of attestation. To test Computer Use you must use a signed build (the default).

---

## 1. TCC authorization (two subjects, independent)

> **Only two permissions: Accessibility + Screen Recording. "Input Monitoring" must never appear in any prompt.**
> Past incident: physical input monitoring was originally implemented with a listen-only event tap, which needs a third TCC permission (Input Monitoring),
> and the authorization card never requested it → on fresh installs `ForegroundLease.acquire` threw
> `focus_isolation_unavailable` for every action, Computer Use was unusable, and the virtual cursor never appeared (the cursor animation runs
> after the lease). It now reads the HID system counter instead
> (`CGEventSource.counterForEventType(.hidSystemState, …)`): zero permissions, cannot fail, and
> `postToPid` injection was measured not to touch the counter. If on a real device every action again reports
> `focus_isolation_unavailable`, someone has added the tap back — roll back per the first two lines of this section.

| # | Step | Expected |
|---|---|---|
| 1.1 | Run the helper for the first time; the native authorization card pops up | The card appears; **the user never has to type a shell command** |
| 1.2 | Click **Open Accessibility** on the card | Goes straight to System Settings ▸ Privacy & Security ▸ Accessibility |
| 1.3 | **Drag** the helper from the card into the Accessibility list | The drop target accepts it; the entry appears and can be toggled on |
| 1.4 | Toggle it on and return to the card | The card status **turns green live** (no app restart needed) |
| 1.5 | Repeat the same flow for Screen Recording | Same as above |
| 1.6 | Rebuild the helper and check permissions again | Both authorizations **are still there** (stable signing identity survives rebuilds). If they are lost, see §0.4 |

> ⚠️ The Screen Recording subject is **the outermost .app on the path**; the Accessibility subject is **the process itself**. You can end up with "Accessibility granted to the helper, Screen Recording recorded under the host's name" — **when troubleshooting, look at them separately; they are not one switch**.

---

## 2. Re-verify the crux (rerun before changing any perception-layer code)

| # | Target | Step | Expected |
|---|---|---|---|
| 2.1 | VS Code | Read the AX tree once **in the background** (not frontmost) | Reads the **full tree** (hundreds of elements), not a dozen shell elements.<br>Background `enableEnhancedAX` should already be in effect |
| 2.2 | VS Code | Bring it to front and read again | Element count of the same order of magnitude as 2.1 |
| 2.3 | NetEase Cloud Music (CEF116) | Read the AX tree of the web area | Always 0 — **this is expected**. Use it to verify the **coordinate fallback path** works: clicking by coordinates hits the target |
| 2.4 | Any app | Watch the entire operation | The real mouse **never moves**; the virtual cursor glides smoothly to the target |

> ❗ Any behavior of "target not found, so fall back to frontmost" is a bug — it ends up operating the host itself.

---

## 2.5 CEF/Electron injection contract (read before changing the injection layer)

Chromium/CEF apps such as NetEase Cloud Music, VS Code, Slack and Discord **route by the window the event declares**. A bare `CGEvent` has a `windowNumber` of 0 and these apps **silently drop it** — the action returns success and the UI does not change. This was the longest-running trap in the project (three rounds of misdiagnosis: first permissions, then coordinates, then the AX tree).

**Clicks must carry window identity** (`WindowTargetedEvent.swift`):
1. `NSEvent.mouseEvent(...windowNumber: targetWindowID...)` then take `.cgEvent` — CGEvent has no public API to set the window number; this is the only route
2. fields 91/92 = window ID
3. `CGEventSetWindowLocation(cg, windowLocalPoint)` — private SPI via dlsym; coordinates = global point − window origin, **top-left origin, not flipped**

**When the target is in the background, also bring it to front and wait for it to settle** (`focusSettleMs = 800`). `SLPSSetFrontProcessWithOptions` is a **real frontmost switch** (not just key focus), and after the switch **the first click is swallowed as an activation click** — waiting 250ms fails every time, waiting 800ms succeeds every time.

**The keyboard needs none of this**: a bare `postToPid` works, fully in the background, without moving the pointer or switching the frontmost app.

| # | Step | Expected |
|---|---|---|
| 2.5.1 | With the target app **in front**, click a text field and type | The caret appears and the text goes in |
| 2.5.2 | Move the target app **to the background** (another app in front) and repeat | Also succeeds; the target is brought to front, which is expected |
| 2.5.3 | With the target **fully in the background**, send keyboard input only (no click) | The text goes in, **the target is not brought to front and the pointer does not move** |
| 2.5.4 | Watch the real mouse pointer throughout | **Never moves** |

If any item fails, check first whether the event carries window identity; don't go looking at permissions / coordinates / the AX tree.

**Judgment discipline**: trust only before/after screenshots, never API return values — "returned success but nothing happened" is exactly the shape of this bug. Several people or agents running injection experiments on the same app at once contaminate each other into false positives; isolate with unique marker strings.

---

## 3. Cross-app semantic control loop

| # | Step | Expected |
|---|---|---|
| 3.1 | `get_app_state` for an app | Returns **an AX tree with element handles** + **a screenshot of that window** (not the full screen) |
| 3.2 | Handles in the tree look like `g17:4` | Not bare numbers. Bare numbers should be rejected |
| 3.3 | In VS Code, click a panel toggle by handle | `Value` 0→1; click again to restore |
| 3.4 | In TextEdit, write text with `set_value` | The text lands in the field; before/after is returned |
| 3.5 | In TextEdit, select a range with `select_text` | Verify with a separate AppleScript reading `AXSelectedText` that it **matches exactly**:<br>`osascript -e 'tell app "System Events" to tell process "TextEdit" to get value of attribute "AXSelectedText" of ...'` |
| 3.6 | `select_text` with `selection_type=cursor_after` | The selection collapses to length 0 |
| 3.7 | Return body of a mutating action | The fixed receipt `Action completed. Call \`get_app_state\`…`, **with no screenshot** (zero implicit snapshots) |
| 3.8 | Use an old handle against a different process | Reports not found — this is **expected**, not a bug |

---

## 4. Visual layer

| # | Step | Expected |
|---|---|---|
| 4.1 | Watch the window of an app being controlled | A **soft glow** around the outer edge of the window, not harshly bright |
| 4.2 | Drag the controlled window | The glow **follows the window** |
| 4.3 | Hide/minimize the controlled window | The glow **disappears with it** |
| 4.4 | Inspect the overlay in screenshots | The virtual cursor and glow **do not appear in screenshots** and **do not consume mouse events** |
| 4.5 | **Multi-display background operation**: put the target app on its own display, work on another display yourself (another app frontmost), and let the agent operate the target | The virtual cursor and glow **still appear on the target's display** — visibility is decided by "is the target window exposed at the action point", not "is the target frontmost" |
| 4.6 | **Fully cover** the target window with other windows, then let the agent operate it | Cursor/glow **do not appear** (drawing over someone else's window would point misleadingly); the action itself still executes |
| 4.7 | While the agent operates the target, switch the host to **native full screen** (or to another desktop Space) and let the agent keep reading state, clicking and typing | The target is **never activated**, the screen is not dragged back to the target's Space, and keyboard and mouse stay yours; the state notes that the target is on another Space and the screenshot may be stale; coordinate clicks, typing and element actions still take effect |
| 4.8 | While the agent operates the target, **minimize** the target window, stay on the same desktop, and let the agent continue | On the next state read the window is restored in the background, **without activating or taking the foreground**; subsequent clicks and typing still take effect |
| 4.9 | While the agent operates the target, **hide** the target app (⌘H), stay on the same desktop, and let the agent continue | The target **stays hidden** when state is read; the agent's next action only shows it in the background (without taking the foreground) and asks for a re-read, after which operation continues normally |
| 4.10 | Stay in the host's **native full screen** while the target is minimized or hidden, and let the agent continue | The target is not activated and the screen is not switched away; once the window is back on a desktop you cannot see, actions are **explicitly rejected** with a reason (never "completed"); things return to normal once you switch to that desktop |

---

## 5. Safety boundaries (confirm on a real device; logic is covered by tests)

| # | Step | Expected |
|---|---|---|
| 5.1 | Ask the agent to control **cc-haha itself** | Refused: `Computer Use is not allowed to use the app '…' for safety reasons.` |
| 5.2 | Control Terminal / iTerm / Chrome | Also refused |
| 5.3 | Press `cmd+q` with systemKeyCombos off | Refused with `Enable system key combinations in Computer Use settings, then retry.` |
| 5.4 | Press it again after turning it on | Allowed |
| 5.5 | A human touches the mouse/keyboard | The helper yields and does not fight the human |

---

## 6. Automated smoke (optional, but run it once)

```bash
bun run check:computer-use-live-smoke
```

The target is TextEdit; it runs the full daemon NDJSON chain and asserts:
- when the AX tree has not changed, the response has the **exact prefix** `There has been no change in the accessibility tree for Window: "`
- **the physical pointer was not moved**
- held input was not contaminated

It takes the Computer Use session lock; **confirm the lock is released afterwards**.

---

## 7. Packaged form

```bash
bun run check:native      # includes swift test + build:sidecars + packaging + smoke
```

After packaging, confirm:
```bash
codesign -dv --verbose=4 "<app>/Contents/Resources/**/cc-haha-computer-use.app" 2>&1 | grep Identifier
```
It must still be `dev.cchaha.cu-helper` — if it changed, electron-builder re-signed it and users will lose both authorizations.
