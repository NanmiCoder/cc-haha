# Computer Use ↔ Codex parity review findings (2026-07-27)

Summary of findings from five independent reviewers plus three rounds of cross-validation. Evidence is **mainly plaintext**: Codex's live MCP `tools/list`, the plaintext JS/`.d.ts` of `@oai/sky`, and the binary symbol surface.

> **Evidence methodology (required reading for whoever comes next)**
> `strings` is **one-directional** evidence for Swift binaries: **a hit = valid positive evidence; a miss = zero evidence, it cannot disprove anything**.
> The reason is that Swift's small-string optimization inlines **string interpolation fragments** of ≤15 bytes into the String struct, so they never reach `__cstring`.
> But you **cannot predict from byte count** whether something "should be found" — `get_app_state` (13B) is still visible as a standalone token, because `__cstring` also holds
> ObjC selectors / C literals / Codable CodingKeys / reflected field names, which do not go through small-string optimization.
>
> **The best evidence path is not the binary**; it is the plaintext here:
> `/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/`
> — `targets/mac/*.js` (policy / telemetry / errors / window_result / native-pipe), `types/window/*.d.ts`, `client.d.ts`.
> The policy document exists twice: `plugins/computer-use/skills/computer-use/SKILL.md` and `.codex-plugin/computer-use-node-repl.md`.

---

## 1. Conclusion

| Layer | Completion |
|---|---|
| **Control core** (Codex's `ComputerUseMCPServer`) | **85–90%** |
| **Codex CU as a whole product** | **45–55%** |

The Codex client binary multiplexes **at least 4** MCP servers: `ComputerUseMCPServer` / `EventStreamMCPServer` /
`ComputerHistoryMCPServer` / `MessagesMCPServer`. We implemented the first.

**Within a turn, control behavior has zero gap with Codex** (both use zero implicit snapshots + live re-resolution on every action).
All gaps are on the cross-turn axis and in the product surface outside the core.

---

## 2. Statements in the archive that were disproven (fix the archive per this table)

| Archive claim | Reality | Evidence |
|---|---|---|
| §2.1 Mutating tools return = rerun `get_app_state` once | **Wrong**. All 8 Codex actions return `Promise<void>`; the docs say "fetch state after acting". **Our fixed receipt is correct** | `client.d.ts`; `sky-window-api.md:12-24`; the receipt string hits verbatim in svc strings; `window_result.js` is only referenced by `get_app_state.js` |
| §2.2 Codex has 9 native tools; `select_text` is a 10th we added | **Wrong**. Codex natively has 10; `select_text` is 6th | live `tools/list` |
| §2.4 Codex sends `element_index` as a string (containing a number) | The type is indeed string, but **the value is a bare integer** | `Element index to click`; node_repl `element_index: 42` |
| §5.3 Record & Replay is the "third" server, 3 in total | **At least 4** (missed `ComputerHistoryMCPServer`, `MessagesMCPServer`). "Exactly 4" cannot be falsified | mangled class names |
| §5.3 per-app instructions "the field exists; we must feed content ourselves" | **Outdated**. v1 already has three real entries for Safari/Finder/Electron + a classifier + unit tests, with delivery format matching Codex verbatim | `AppGuidance.swift`; `window_result.js` |
| §5.3 / §6 elicitation is a "hidden prerequisite; never checked whether the SDK supports it" | **Resolved**. SDK 1.29.0 supports it fully in both directions, zero upgrade cost | `sdk/dist/esm/server/index.js:351,394`; `types.js:335-345` (`{}`→`{form:{}}`) |
| §6 "Codex uses XPC, we use a socket" | **Half right**. The same Codex service accepts both XPC (Swift side) and a **length-prefixed socket** (JS side); the latter is the same kind as ours. Severity downgraded | `nm -u` XPC symbols; `native-pipe.d.ts` |
| §4 Verdict one: reading the tree requires bringing to front | **Directly conflicts** with the new verdict in our code; see the open item in §5 below | `AXTree.swift:230-241` |
| §1.2 glide blocks clicks for 500ms | **Fixed** (now bounded at 0.1s, and only paid when the target is frontmost) | `OverlayPolicy.swift:36-52` |
| §1.2 `screenshotFiltering` misrepresents the security model | **Now dead code** (darwin does not use the legacy surface, win32 never gets `'native'`) | `common.ts:59-81`; `mcpServer.ts:307-313` |
| §1.2 No UI settle; captures the moment a command arrives | **Still true**, see §4 | `Capture.swift:434-452` |

---

## 3. One advantage of ours that must be remembered (don't "optimize" it away)

**Zero implicit snapshots are safe only because every action does live re-resolution, not because AX references are cached.**

`AXTree.refetch(pid:index:)` (`AXTree.swift:453`) **re-walks the path from the live root**, never reusing the `AXUIElement` from snapshot time,
and verifies a semantic fingerprint. Together with the four-layer precondition guard in `guardStaleness` (`CommandRouter.swift:1369`, called by all 6 action entry points),
**the failure mode is "a hard error with an actionable hint", not "a silent wrong click"**.

The fingerprint is much stricter than intuition suggests (`ElementFingerprint.swift`):
- fingerprint = `{role, subrole, identifier, title, valueKind}`; **the raw `title` is compared**, only `value` is reduced to a "kind"
- each hop of the path stores **the fingerprint array of all siblings at that level**, and re-resolution requires the whole array to match element by element
- `SnapshotPathStep.init?` requires the selected fingerprint to be **unique among its siblings**, otherwise the locator **cannot even be built at snapshot time** — ambiguous cases are never deferred to action time

⇒ Any change that "replaces `refetch` with cached AX refs for speed" destroys this guarantee.

Also, `sessions[pid]` is **written only by `get_app_state`** (`AXTree.swift:217`), so **the tree in the model's hands and the daemon's snapshot are always the same frame**.
This is a guarantee by construction — the mismatch of "clicking with a tree from 3 actions ago while the diff only reports changes since the last query" is **structurally impossible**.

---

## 4. Gaps (grouped by whether they block core control)

### Blocking core control (2 items)

1. **No post-action UI settle**. Codex has `needsUISettleBeforeSkyshot` (waits ~1s after an action, longer when there is a loading indicator
   — ⚠️ the exact duration comes from a paraphrase in the node-repl docs and is **not independently confirmed**; the mechanism itself is confirmed by the symbol name).

   > **Two reviewers rated the severity of this item differently; that is not smoothed over here:**
   > one listed it as "blocking core control"; the other rated it **medium** rather than high, reasoning that precisely because we, like Codex, do not re-snapshot automatically,
   > the model's `get_app_state` is a separate MCP round trip, naturally separated by hundreds of milliseconds to seconds of model latency, which **incidentally** provides plenty of settle time,
   > so it is not as fatal as the v0 described in archive §1.2. But that is **a side effect, not a guarantee**, and it does not cover "the model happens to ask mid-animation/mid-load".
   > Conversely: Codex also uses a fixed receipt yet **still** keeps `needsUISettleBeforeSkyshot` — which shows OpenAI does not consider the model round trip sufficient.

   Our `get_app_state` path has zero settle: `settleUntilNonShell` is an **AX warm-up before reading the tree** (and is skipped outright for processes already proven unchanged),
   and there is no wait at all before `Capture.windowShot`.
   ⚠️ This and the following are **the same thing in the wrong layer** and should be fixed together:
   `AXAction.swift` does `Thread.sleep(0.15)` after every successful action (11 places in the file), while `AXAction`/`CommandRouter` are both `@MainActor`
   — violating this repo's own AX threading red line; and the reason in its comment ("the next get_app_state, re-snapshotted automatically by the router, will reflect the change")
   **has been disproven** (the router no longer re-snapshots), so it is now pure dead cost + stalls the cursor animation.
   → Correct fix: delete the post-action `Thread.sleep`, move the wait before the `get_app_state` screenshot, make it adaptive, and use `Task.sleep`.

2. **`permissionsPending` has no re-polling**. Codex has a first-class error code `-10014` with "Do not end your turn yet, just call this tool again.";
   we return a terminal error + fire-and-forget the card ⇒ **the moment the user finishes granting permission, the model has already given up on this turn**. Changing one sentence of prose fixes it.

### Cross-turn (the only axis where we are worse than Codex)

3. **No TurnEnded protocol**. Codex has a kill switch: "Computer Use is unavailable because the current turn ended."
   Our diff epoch only recognizes (proven process identity, key window ID); **it recognizes neither turns nor the user's manual actions**.
   A scenario that will certainly happen: the model reads the tree → the turn ends → **the user works manually for 5 minutes** (same window, same process) → a new turn reads again → the epoch is still reused →
   the model receives a diff against the frame from 5 minutes ago, and **the full text of that baseline is no longer in its context**.
   ⇒ The damage is "**the model cannot see the diff baseline**" + "no cross-turn protection", **not** "it will click the wrong thing" (wrong clicks are blocked by the guards in §3).
   **Cheap mitigation (do this first)**: Codex teaches the model to self-manage in the node-repl docs —
   *"If you disregard the text from a previous call to get_app_state… get the full tree next time you inspect AX text."*
   Our `disableDiff` description has no hint at all about "when to pass true". **Adding one line of prose covers the most common symptom**, at far lower cost than a three-layer protocol.

### Product surface (does not block control)

| Item | Codex | Ours |
|---|---|---|
| Four-tier confirmation policy | **A full prose copy on each of two surfaces** (SKILL.md + node-repl.md) | **0/4**. All 9 gates govern "who can be controlled"; none governs "how dangerous this action is" — clicking "Delete account" equals clicking "Refresh" |
| Structured `risk` | `high\|low`, **decided per app** (inputs are only bundleID + urlDomain), only affects prompt wording and persistence tier | No risk dimension; only an "always" tier, no session-only |
| Telemetry | Two layers: 4 Swift `time_*` + 4 JS Statsig events | 0/8, only `error_kind` |
| node_repl script surface | The model writes JS that **batches several actions in one call** | One MCP round trip per action (order-of-magnitude token/latency difference) |
| Guardian | 11 classes (lock screen / password field detection / auto-unlock / URL blocklist / SSRF) | 1/11 (only yielding to physical input) |
| Skysight memory | event stream → 10min/6h LLM summaries + sticky-taint injection boundary | 0 |
| Screenshot transport | `file://` URL | base64 inline (+33%) |
| Cursor raster | 45 PNG frames | Loader in place, 0 frames, procedural (**deliberate**; the 45 frames are OpenAI copyrighted assets) |

> **The four-tier confirmation policy can be implemented purely in prose** — Codex itself does exactly that; the four-tier decision is made 100% by the model reading prose, with zero code support.
> The structured `risk` cannot carry four tiers and was not designed for them. Adding a structured risk engine would be optional hardening beyond Codex.

### Performance

**Zero use of batch read APIs**. Codex imports `AXUIElementCopyMultipleAttributeValues` / `CopyAttributeValues` / `GetAttributeValueCount`;
all our attribute reads go through a single funnel `rawAttribute()` (`AXTree.swift:1832`), **one cross-process IPC per attribute**,
measured at **22–35 per element**; a full tree (cap 1500) can reach **30–50 thousand AX calls** in a single `get_app_state`.
Good news: there is a single funnel, so the change is confined to one function.

---

## 5. The one open assumption that "zeroes the whole architecture if wrong"

`AXTree.swift:230-241` asserts "Codex does **not** bring to front to read the tree; `enableEnhancedAX` is the real trigger", and on that basis removed `running.activate(...)`.
This **directly conflicts** with the on-device measurement behind archive §4 verdict one (VS Code in background: 19 shell elements → brought to front: 225).

If the full tree really cannot be read in the background, `get_app_state` returns an empty shell tree and the model cannot hit anything by index — **the premise of the whole semantic loop fails**.

**Verification cost is tiny**: with the installed `.app`, run `get_app_state` once with the same Electron app in front and once in the background, and compare `elementCount`.
See `computer-use-native-manual-qa.md` §2.1–2.2. **This should come before all other work.**

(Circumstantial but inconclusive: Codex has `activate*` selectors and listens to `NSWorkspaceDidActivateApplicationNotification`,
but that may only serve its own authorization window — **unconfirmed**.)

---

## 6. Parity defects (fixes are clear)

| # | Problem | Fix |
|---|---|---|
| 1 | `select_text` parameter name: the Codex MCP surface uses **`selection`**, ours uses `selection_type`. With no `additionalProperties:false` ⇒ a model passing `selection` per the Codex contract has it silently swallowed → falls back to default `"text"` → **selects text instead of placing the caret, with zero errors** | Make `selection` the official name and keep `selection_type` as an alias (backed by the Codex JS facade), via the existing `rejectAliasConflict`. The three existing tests need no changes |
| 2 | **All 10 schemas lack `additionalProperties:false`** (Codex has it on 10/10) — this is the **amplifier** of #1 and a breeding ground for the next such issue | Add it everywhere; first confirm every alias is declared in `properties` |
| 3 | **All 10 tools lack `annotations`**. Codex: `list_apps`/`get_app_state` = `readOnlyHint:true`+`idempotentHint:true`; the other 8 have all four hints false; `openWorldHint` false everywhere | Copy as is |
| 4 | **4 model-visible fields skip `sanitize`**: `Help:` / `Description:` / `ID:` / the `Window:"…"` header line. `labelFieldText` **computes `sanitize()` but does not use it** (only uses it to compare link prefixes; the output uses the raw string). Consequence: an app can set AXDescription to a string containing `\n\t` and **forge tree lines with fake handles** (indentation is the only structural signal), and these 4 fields also lack the 160 truncation | Restore the calls. Note: this is not about "whether to match Codex" — `AXTree.swift:34` and `:1694` are **our own declared format contract**; hardening = restoring consistency |
| 5 | App-specific instructions are **not de-duplicated per app** and are resent on every `get_app_state`. Yet the Swift comment in `AppGuidance.swift:15-17` **already promises** "TS injects on the app's first occurrence" | De-duplicate by bundleId (both Codex facades do this) |
| 6 | `tools.ts` describes `disableDiff` as "a cumulative diff against the previous snapshot" — **semantically contradictory** (a cumulative diff's baseline is the initial one, not the previous one), and Swift only implements previous-diff | Fix the wording. **Note**: previous-diff is Codex's documented default; our implementation is correct and **does not need** cumulative |
| 7 | Value substituted into the refusal text: Codex substitutes `bundleIdentifier`, we substitute the name the model passed. Codex also has a second "organization policy" refusal tier | Low priority |
| 8 | Bounds stricter than Codex: `click_count`≤3, `pages`≤10, coordinates `minimum:0` (Codex has no cap) | Rejects calls Codex would accept; relax as needed |

---

## 7. Deliberate deviations (kept, but must be documented rather than silently left in)

**`element_index` uses an opaque handle `g<epoch>:<id>` (e.g. `g17:4`); Codex uses a bare integer.**

- **Why kept**: a stale integer **silently** points at whatever other element "now occupies that position"; our epoch prefix makes it **an explicit error**. The failure mode goes from silently wrong to a hard error.
- **Cost**: ① the model's prior is a bare integer, so it must copy the handle exactly; ② **incompatible** with third-party agents trained on the Codex format and with replaying real Codex traces; ③ a few hundred more tokens per `get_app_state`.
- **Documentation contradiction that must be resolved**: `01-architecture.md` §2.4 says "the format must match verbatim", while `02-swift-helper.md` §2.3 says "the model sees this string, not a bare index". The two contradict each other.

Similarly: the JS surface confirms Codex has no `<app_state>` wrapper tag, and on the MCP surface it cannot be falsified; judged **harmless**, but stop treating it as parity evidence
(the test case name in `toolCalls.test.ts` asserts our own invention).

---

## 8. Verified as fine (don't reopen)

- The 10 tool names and order match **10/10 verbatim**
- Mutation receipt `Action completed. Call \`get_app_state\` to fetch the updated UI state.` **matches verbatim**
- Refusal template `Computer Use is not allowed to use the app '<app>' for safety reasons.` **matches verbatim**
- `app` is **required, with no frontmost fallback** on the 9 targeted tools — same as Codex
- `defersLockAcquire === "list_apps"` — consistent with Codex "the 9 targeted tools are wrapped in policy; only `list_apps` is not"
- The `l`/`r`/`m` and `u`/`d`/`l`/`r` aliases **already exist in Codex** (exhaustive union types in `MouseButton.d.ts` / `Direction.d.ts`)
- skyshot tree-line syntax: indentation / role / traits / field order / focus trailer / `_NS:` filter / frame not in text — all implemented
- `Removed element IDs: ` and `with ~ and + representing…summarized by ID range.` — **word-for-word** identical to Codex
- Keeping a synthesized-event fallback in the injection ladder is **justified**: `CGEventPost`/`CGWarp`/`IOHIDPostEvent` are 0 across all four Codex binaries (the only CGEvent symbol is the read-only `_CGEventGetFlags`),
  but Codex ships its own feature flag `computerUseAlwaysSimulateClick` ("Prefer simulating physical clicks over Accessibilty actions.")
  ⇒ OpenAI itself acknowledges cases where AX is not enough. And **the coordinate fallback is the only path for CEF-class apps (verdict two) and must not be removed**; the affine transform is implemented
- **Zero violations** of the crux verdicts: no "target not found, fall back to frontmost" (fail-closed in both TS and Swift); `activate` is removed completely
  (the only `runtime.activate` in the repo is in the `.restore` branch at `ForegroundLease.swift:317`, which **gives the user's original frontmost app back** — the opposite direction)
- The warm-up polling code **has a new foundation**: the reason is now "Chromium attaches the tree asynchronously after `enableEnhancedAX`", with a termination condition, a 1.2s cap, once per process — bounded cost
- `get_app_state` **does** launch a non-running app in the background (`activate: false`), same as Codex — the sentence "must never launch anything" is a comment on `resolveTarget`
- **We do have** a `get_app_state` precondition, on the Swift side (each of the three addressing modes has a fail-closed refusal path), equivalent in shape to Codex `noActiveSession: -10011`

---

## 9. Residual risk (outside this review's scope, but noted)

The frontmost fallback at `Injection.swift:262-289` only serves the legacy `key`/`hold_key`/`type`/`paste_clipboard`;
it is unreachable from the semantic surface (darwin), but **these four commands are still exposed on the daemon socket**. This is a security concern.
