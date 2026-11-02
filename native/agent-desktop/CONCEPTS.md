# Concepts

Shared domain vocabulary for this project: entities, named processes, and status concepts with project-specific meaning. A glossary, not a spec or catch-all.

## Desktop Observation

### Accessibility Tree
A structured representation of an application's user interface exposed by the operating system accessibility APIs and used by agent-desktop as the source of truth for observation and semantic interaction.

### Snapshot
An observation of an accessibility tree at a point in time, persisted with the element refs allocated from that observation.

### Visual Debug Artifact
A standalone, opt-in visualization that pairs a snapshot's returned nodes or a click's pre-dispatch target with window screenshots, using labeled bounds and role-group filters for human inspection.

Its filters change only the visualization, not the recorded command result or the desktop. Before/after images are separate observations, not a recording or proof of action delivery.

### Snapshot ID
A compact identifier for one persisted snapshot. Lookup is confined to the selected session namespace, so an ID created in a session is not a cross-session handle.

### Surface
A scoped UI layer that can be observed separately from the whole window, such as an open menu, sheet, popover, alert, or focused area.

### Window Rectangle
On Linux, the visible window bounds shared by window listing and window commands exclude any client-side drop shadow.

On Linux, a move or resize names this rectangle, and a refusal reports requested and observed bounds in the same terms. Matching bounds during a window-manager animation are provisional; placement must still satisfy the request after a full confirmation pause before it counts as held.

### Drill-down
A snapshot operation that starts from an existing ref to observe that element's subtree instead of re-reading the entire window.

### Partial Observation
A snapshot that ran out of its allotted time before finishing the tree and returns what it did observe rather than discarding the walk.

Completeness is reported on the observation as a whole and on each node whose descendants were cut, so a reader can walk from the root to the boundary. A depth clamp knows how many children it skipped and says so; budget exhaustion cannot afford that count and marks the node without one. Only a full snapshot may be partial. A drill-down replaces refs inside an existing map, so it requires a complete observation and fails rather than destroying descendants it cannot re-allocate.

### Web Wrapper
A non-semantic container element, produced by web-rendered content, that consumes raw depth but no logical depth during a walk.

Web stacks (Chromium/Electron, WebView) wrap content in chains of anonymous containers: UIA `Group`/`Custom`/`Pane`, AX groups, AT-SPI panel/section/filler. A transparent wrapper has no name, value or developer identifier and advertises no action beyond the ubiquitous scroll-into-view (macOS and Linux also ignore context-menu and focus). A bare `ScrollTo` therefore does not defeat the skip, because it carries no information an agent could act on. Skipping these nodes' logical depth lets a dense web app fit a default depth budget; without the skip, the same app understates its reachable content by an order of magnitude. On Windows the skip is gated on detected Chromium provenance (root window class `Chrome_WidgetWin_1`) rather than applied everywhere: the identical emptiness test would otherwise skip the anonymous containers native stacks are full of. macOS and Linux apply the emptiness test to every app. A named or actionable wrapper still consumes depth, because it is then a real element rather than a transparent scaffold.

## Vocabulary

The four platform-neutral vocabularies every adapter produces and core consumes, and the evidence model all four rest on. They are shared contracts: an adapter that emits a token outside one of them is emitting something no consumer can act on.

### Evidence Tri-State
Every property an adapter reads is `Known`, `Absent`, or `Unknown`, and the three are never collapsed into two.

`Absent` is an answer: the provider was asked and does not have this. `Unknown` is the lack of one: the read failed, or what it returned cannot be trusted. The distinction matters in both directions. `Absent` satisfies completeness gating and `Unknown` must not, so a target that never answered cannot pass for one that answered "no". Conversely a role, state, or affordance is granted only on a positive claim, so a failed read withholds it. A convenience predicate that flattens the tri-state to `bool` is therefore safe only in positive position, asking "did this say yes", and fails open the moment it is negated, because negation silently rewrites "I could not tell" as "definitely not".

### Role
The canonical kind of a control, drawn from a closed set core owns.

Each platform maps its own taxonomy onto it (macOS from `AXRole` plus its subrole fold, Windows from UIA's `ControlType` refined by pattern availability, Linux from AT-SPI role numbers) and never invents a token. The platform taxonomies are not parallel: UIA's `Tab` is the container and its `TabItem` is the page selector, which is the inverse of the ARIA naming core follows, and several canonical roles (`switch`, `colorwell`) have no control type at all and are reachable only through refinement or not at all. A role core does not recognise is `unknown`, which is a positive statement about the element and is distinct from a read that failed.

### State Vocabulary
The closed set of state tokens a node may carry, owned by core rather than by any adapter.

Adapters emit only members of it, and a membership assertion is paired with a negative control so it cannot pass vacuously. A token is emitted only where the platform evidenced it: where a platform has no source for a reserved token, the token stays unproduced rather than defaulted. Emitting from an ungated source is the usual failure here: a property that reports a plausible value on an element whose provider never implemented the underlying pattern will decorate every inert node in the tree with states it does not have.

A role mapping can put a reserved token out of reach for the same logical control on one platform without the token itself being wrong. A toggle button surfaces as `role: button` with state `pressed` on macOS, because macOS keeps the control's role as `button` and reads its toggle value as `pressed`. Windows reclassifies any `Button` control type that advertises toggle support to `role: switch` with state `checked` before states resolve, and Linux reports a toggle button as `checked`, reserving `pressed` for push buttons. Windows still produces `pressed`, but only for a `button` whose `LegacyIAccessibleState` carries the pressed bit (a toolbar toggle that advertises no toggle support). The macOS/Windows divergence for the same control is a consequence of two correct role mappings meeting it, not a defect in either.

### Name Evidence
The raw slots an adapter supplies so that core, not the adapter, computes the accessible name.

The slots are ranked by one precedence shared across platforms, and each slot carries its own read status, so uncertainty travels: when a source that would have outranked the winner failed to read, the name is unknown rather than the weaker source's value. A platform folds its own gating (which slots apply to which roles, whether children were fully enumerated) into those statuses before calling, so the shared computation never sees a platform-specific token. An adapter that computes its own name is a second precedence, and two precedences drift.

### Native ID
The strongest developer-assigned identifier a platform exposes for an element, carried in `native_id`.

Windows supplies UIA's `AutomationId`, macOS `AXIdentifier` or `AXDOMIdentifier`, Linux AT-SPI's `accessible-id` or, inside a web document, the DOM `id`. It is typed rather than bare: an identifier whose kind is unknown is rejected at persistence, so the kind travels with the value. A blank value is no identifier at all: publishing one would give every unidentified element the same key. A read that failed is incomplete evidence rather than an absent identifier, because "absent" satisfies completeness gating and a target that never answered must not. Coverage varies by an order of magnitude across UI stacks, so it is a strong hint for re-identification and never a sufficient key alone.

## Refs And Identity

### Window Identity
The durable identity of a window, used when observation resolves a snapshot root or a stored ref.

Window handles can be recycled: after a window is destroyed, the OS may hand its handle to a different window. A handle alone therefore names the wrong window after churn. Identity is the handle corroborated by a process-generation token (a value derived from the owning process's creation time), so a recycled handle whose process generation no longer matches fails closed rather than resolving to the new occupant. The corroboration is strict for a window freshly listed in the same invocation, and tolerant of title drift for a stored ref (titles legitimately change under a live window), per platform: Windows pairs the HWND with a creation-time token, macOS the window number with a process start-time token, Linux the X11 client id with a boot-id-qualified process start-time token.

A handle's identity can be invalidated at any point between an observation and a later action on it, and checking it once at the start of that gap only proves it was valid then. Where the check and the act cannot be a single atomic operation, the corroboration has to be repeated immediately before each write the action performs, and the action's own success check must itself be identity-qualified, confirming the responding resource is still the expected occupant and not merely that some resource at the expected handle responded, or a recycle occurring late in the gap reports success over the wrong resource.

### Display Identity
The durable identity of a display used when a screenshot targets a monitor selected from a prior list.

A monitor handle alone is recyclable after hot-plug or mode change. Identity is the handle corroborated with bounds, primary flag, and scale: every field must still match, or the capture fails closed rather than attributing pixels to the wrong surface.

### Identity Sandwich
A pre-capture and post-capture identity check around a long-running capture call so a mid-capture reorder discards the bytes instead of returning them under the original target's identity.

### Ref
A short element identifier assigned by agent-desktop to an actionable or drillable node in a snapshot.

A node is actionable when its role is interactive or it advertises a primary action. Focus, context-menu, and scroll-into-view affordances do not count on their own, because web runtimes advertise them on nearly every node.

Refs are deterministic inside one snapshot but are not stable across UI changes. Snapshot and find output qualify each ref with its snapshot ID, and every command accepts only the qualified form. A bare `@eN` fails with `INVALID_ARGS`.

### RefMap
The persisted mapping from refs to the identity evidence needed to re-identify elements later.

### Stable Text Identity
The role-conditional text evidence used during strict ref resolution.

Names and descriptions can identify a ref when they are stable labels. Mutable control values, including text field content and value text promoted into an accessibility name, are volatile and do not identify the element by themselves. Core owns this policy so macOS, Windows, Linux, CLI, and FFI consumers share the same semantics.

### Stale Ref
A ref whose stored identity no longer matches a live element strongly enough to act safely.

### Strict Ref Resolution
The fail-closed process of re-identifying a ref from stored identity evidence before a command acts on it.

Strict ref resolution rejects missing, stale, and ambiguous matches instead of guessing. It is the boundary between an old observation and a live desktop mutation.

### Graded Resolution
The order a resolver follows to re-identify a ref, on the evidence the ref carries: it walks the stored positional path first, then falls back to a bounded broad search. A candidate is confirmed by identifier first, then by role-conditional stable text; only a ref with no meaningful identity can resolve by unique geometry, as a last resort. Each tier is a locator, never an identity by itself: a path or a bounds match is always verified against the stored identity evidence before it resolves.

The geometry promotion is deliberately narrow: it fires only when the ref has no meaningful identity and stored bounds, and it resolves only on a unique live match. On Windows and Linux the stored bounds must also be a positive-area rectangle: a zero-extent stored hash never promotes, because offscreen and virtualized elements collapse to shared degenerate rectangles that are structurally non-unique (A17-7). macOS has no such check.

## Read Outcomes

The four-way verdict a failed native read is classified into before anything decides what to do about it (the Windows adapter's type is `ReadDisposition`; macOS and Linux apply the same split without a shared type). The verdict settles two things, and nothing else does: whether the answer is final, and whether repeating the read could change it. Collapsing any two of the four is a common mistake: treating a structurally impossible answer as a transport failure burns an entire deadline retrying what cannot succeed, and treating a transport failure as final reports a property as absent when nothing ever asked the target successfully.

### Settled Absence
A final answer that what was asked for does not exist: the provider does not implement the property or pattern, a completed search matched nothing, an anchor path that churn has made permanently wrong. The read is therefore never retried.

Distinct from Evidence Tri-State, which grades one field of one read that succeeded; this grades the read itself. A completed search that resolved nothing is settled the same way, and reports its retryability from its error's own default rather than asserting a verdict of its own. That is what lets a caller spend its one fresh re-observation without the adapter first burning the deadline replaying a search it already knows will fail (`UiaFailure::is_absence` in the Windows adapter).

### Retryable Failure
A non-answer about the transport rather than about the target: the call timed out, faulted, or could not complete. It leaves the operation incomplete, and the same read is worth repeating until the operation's deadline. At that point the operation is stamped as having run out of budget rather than silently discarded.

*Avoid:* transient failure, transport error.

### Unavailable Element
A report that the element itself has gone, whose finality depends on where it was hit: for the element a command already resolved it settles as a stale ref, while for a node met part-way down a walk it only marks that branch incomplete and leaves it retryable.

### Terminal Failure
A failure with no defined recovery: a denial, or a code nothing has classified. It is final in the same way a settled absence is, but it says nothing about the target, and it surfaces to the caller as it stands.

An unrecognised failure code lands here by default, so a read nobody has classified surfaces rather than being guessed into a retry loop.

### Enumeration Exhaustion
A child enumeration ending because it ran out of children, which the platform reports through the same error channel as a genuine fault and must be split back out from it.

Retiring both through one arm is how a hung or faulting target becomes a truncated tree that reports itself complete: exhaustion ends the list and leaves the subtree complete, while anything else marks it incomplete and surfaces a structured error. The values that distinguish the two are measured against the real platform, never inferred from the client library's types.

## Coordination

### State Root
The single on-disk directory that owns everything the CLI persists: sessions, snapshot refmaps and their locks, trace segments, and the `latest_snapshot_id` pointer. Default is `~/.agent-desktop`.

`AGENT_DESKTOP_HOME` relocates the state root; the env value is the root itself, with no `.agent-desktop` suffix appended. Resolution lives in core and is identical across platforms. Explicit user-given output paths (`screenshot [PATH]`, `trace export --out`, `--trace <path>`) are not re-rooted.

### Session
An on-disk container under `~/.agent-desktop/sessions/<id>/` that owns snapshot refmaps, a `trace/` directory, and a `session.json` manifest.

`session start` writes the manifest (`trace: on` unless `--no-trace`) and pre-creates `trace/`. It returns the new ID but does not activate it for later processes. Explicit `--session` takes precedence over `AGENT_DESKTOP_SESSION`; with neither, commands use the global, non-session namespace. Bare `--session <id>` without a manifest remains snapshot-namespace-only for backward compatibility.

The manifest holds the id, optional name, `created_at` / `ended_at` timestamps, `trace: on|off`, `artifacts: full|events`, and `cursor_overlay` when enabled. Structured file tracing activates only while the manifest has `trace: on` and the session has not ended; FFI adapters and bare `--session` ids without a manifest do not write trace segments.

Use sessions when callers want a coordinated snapshot namespace and trace sink. Every lookup is confined to its selected namespace, so a snapshot created under a session requires that same `--session` or `AGENT_DESKTOP_SESSION` scope later. Qualified refs remain the deterministic path for pinned actions inside that namespace.

### Trace Segment
One append-only JSONL file per OS process under `<session>/trace/<pid>-<procStartTs>.jsonl`, written lazily with atomic lines. Each new segment opens with a `trace.meta` header (`schema`, binary version, `os`, `pid`, `proc_start_ms`, `session_id`). Older traces without meta read as schema 0. Explicit `--trace <path>` overrides to a single file.

### Trace Timeline
The merged, deterministic ordering of all events from every segment in a session, produced by `trace show` and `trace export`. Merge key is `(ts_ms, writer pid, in-file position)`; the reader tolerates truncated tails, corrupt lines, and foreign files with counted warnings rather than hard errors.

### Trace Schema
Additive-only evolution contract: new event types and optional fields may appear; existing meanings never change. Readers ignore unknown content. Segments declare their schema in the leading `trace.meta` line; unknown future schemas warn and parse best-effort.

### Replay Artifacts
Opt-in capture mode (`session start --screenshots`, manifest `artifacts: full`) that stores pre/post-action PNGs under `<session>/trace/screens/` and refmap copies as `<session>/trace/refmaps/<snapshot_id>.json`. Event-mode traces (`artifacts: events`, the default) record JSONL only. Artifacts are unredacted and may appear in exported HTML, so treat them like screenshots.

### Protected Process
A session-critical operating-system process that agent-desktop refuses to close on every surface, because terminating it would break the user's desktop session.

The refusal is enforced where the close happens, so CLI, FFI, and any future consumer behave identically. Matching is exact per platform (macOS: the process name or a dot-separated bundle-identifier component; Windows: the exact image name), never a substring, so lookalike applications that merely contain a protected name stay closable. The refusal code is `INVALID_ARGS` with `disposition.delivery: "not_delivered"` (`crates/core/src/commands/close_app.rs`, pinned by `close_app_blocks_adapter_protected_process` in `close_app_tests.rs`; Windows `explorer.exe` in the `crates/windows/src/system/app_ops.rs` tests), not `PERM_DENIED`. The process is simply not a closable target.

## Action Reliability

### Actionability
The pre-dispatch judgement that a resolved element is safe to act on, based on native evidence such as visibility, stability, enabled state, supported action, policy, and editability.

### Auto-Wait
The default-on bounded poll that holds a ref action until its target becomes actionable, then fails with `TIMEOUT` if the budget expires.

The bound is 5000ms (`type` adds 30ms per character of its text); `--timeout-ms 0` restores single-shot act-immediately behavior. Transient checks (visibility, stability, enabled, occlusion) are polled; terminal checks (supported action, policy, editability) fail fast without waiting out the budget.

### Actionability Battery
The shared pre-dispatch set of live checks core runs against a resolved element: visible, stable, enabled, supported action, policy, editable, and receiving events, before any adapter dispatch.

Two hit-test shapes must not be conflated. The battery's `receives_events` check sweeps five candidate points from the element's bounds (center plus four quadrant points) and passes if *any* reaches the target, asking whether the element is reachable at all so a partially occluded control still passes. The pointer pipeline asks a different question at the single coordinate it has already resolved and will move the cursor to; a target that satisfies the battery can still fail that single-point check.

### Occlusion Gate / Hit Test
The three-way probe that asks whether another element visibly intercepts the action point: `ReachesTarget`, `InterceptedBy { role, name, bounds }`, or `Unknown`.

The gate fails open on `Unknown`: unavailable evidence never false-fails an action the dispatch outcome will judge. `InterceptedBy` requires positive evidence: within an agreed window attribution the platform's hit-test verdict alone, or two-opinion agreement when the hit belongs to another window, so an inconclusive probe cannot invent an occluder.

### Delivery Semantics
What a failed or uncertain action says about whether input actually reached the application, and therefore whether repeating it is safe.

The distinction that matters is not success versus failure but delivered versus not: an action that never reached the target can be retried freely, while one that may have landed cannot be repeated without risking a duplicate. Verification is a third axis: an action can be known-delivered yet unverified, meaning the input was posted but its effect was not confirmed. Errors carry this alongside the recovery hint so a caller never has to infer retry safety from an error code. A refusal that can have delivered nothing, an argument error or any error of a read-only command, is stamped not delivered with a safe retry at dispatch, so a caller never sees an unknown disposition for a request that sent no input. On Windows, `SendInput`'s injected-event count is never treated as delivery evidence, because the API reports success in both delivered and UIPI-blocked arms (A9-3). Physical steps therefore report `delivered_unverified` and effect is judged by independent re-read where one exists.

### Mutation Classifier
The write-path table that turns a failed native mutation into a delivery verdict before any chain step or error envelope is built.

It answers whether the write was delivered, whether the affordance is genuinely absent (fall through to the next chain rung), or which structured failure and disposition apply. It is the write-side counterpart of Read Outcomes and must never reuse that cluster: the read table's retryable transport codes are exactly the HRESULTs a write may already have delivered, so consulting it would authorize a double-dispatch (A19-2; Windows `actions/mutation.rs`, Linux `actions/write/mutation.rs`, macOS `actions/ax_mutation.rs`).

### Secure Field
An element whose content must never appear in observation or action surfaces once the platform marks it secret (`IsPassword` on Windows; the AT-SPI password role on Linux; equivalent password/secure-text roles on macOS).

The contract spans both sides: the **read side** withholds value and related text evidence and resolves by content-free fingerprint; the **action side** may write into the field but never echoes the attempted or observed value in steps, messages, `details`, `platform_detail`, or post-state, and reports `verified: None` when a re-read cannot confirm without leaking (A19-3).

### Interaction Lease
Machine-wide exclusivity over desktop input, held by one process at a time so concurrent callers cannot interleave synthetic input into each other's actions.

The lease covers dispatch only, never the waiting that precedes it: waiting for an element to become actionable can run long, and holding exclusivity across it would serialize every caller on the machine. Anything resolved while waiting was therefore observed without exclusivity and is re-resolved once the lease is held. That second resolution is the correctness boundary, not redundant work.

### Capability Vocabulary
The platform-neutral set of supported action names that core uses to compare command intent with native adapter evidence.

Each adapter maps native primitives into this shared vocabulary before core evaluates actionability. New commands should extend the central vocabulary first, then reuse it from actionability, ref allocation, predicates, FFI tests, and platform adapters.

### Interaction Policy
The side-effect contract attached to an action request, controlling whether the command may steal focus, move the cursor, or use physical input. The CLI exposes two: **headless** (the default; accessibility-only, no cursor, fails closed when the semantic path is unavailable) and **headed** (opt-in via the global `--headed` flag; authorizes the action's declared focus and cursor preconditions). A third, **focus fallback**, sits between them: it permits focus but not cursor movement. It is not reachable from the CLI flag. It is the base policy of an explicit key press, and language bindings may select it directly.

Core owns the precondition each action declares: a focused window for keyboard or focus-sensitive work, a focused window plus a verified cursor target for pointer delivery. Core satisfies it before dispatch. For ref actions core focuses the exact source window, not merely the owning application; the platform adapter owns the OS-specific focus primitive and delivery mechanism. Raw coordinate input has no ref identity, so it never infers or focuses a window. Which actions a headed policy makes physical rather than semantic is per-action and per-platform, and is settled by that action's own chain rather than by the policy. On Windows, `type` has no semantic headless path, because UIA offers no insert-at-selection write. Strict-headless `type` therefore fails at policy, and `set-value` is the headless text path. Headed `type` synthesizes keys physically (A4-1).

### Agent Cursor Overlay
An optional presentation-only cursor driven by verified action destinations. Its whole configuration (label, colours, size, and click effects) is set once per session with `session start --cursor` or `cursor-overlay enable`; action and batch commands inherit it and take no cursor flags. Motion models a human hand and the cursor never rotates or resizes. The renderer acknowledges arrival before the action dispatches, under a bounded timeout, so the picture and the real effect stay in step. A click plays a ripple and flashes an outline around the element. A `--headed` mutating command hides the overlay before it dispatches and shows it again afterwards; on Windows the renderer stays suppressed for headed input and draws only for headless semantic actions. It never moves or replaces the OS pointer and never changes Interaction Policy, action delivery, or response semantics. Configuration, motion, and effect timing live in `agent-desktop-core`; macOS, Windows and Linux (X11 only) supply native renderers, and an adapter that does not override `update_cursor_overlay` refuses with `PLATFORM_NOT_SUPPORTED`, which dispatch treats as `rendered: false`.

For harness subagents, `session start --cursor --multi-agent` enables a cursor per `(session-id, agent-id)` (macOS, Windows, and Linux X11). The harness assigns each subagent a stable global `--agent-id` or `AGENT_DESKTOP_AGENT_ID`. The CLI requires this identity for desktop UI actions in that mode. The interaction lease still serializes physical input on the shared OS pointer. A headless action moves its cursor before it takes the lease, so several agents' cursors travel at the same time while their actions take turns. Commands that draw the same cursor take turns from its travel to its click effect. Each cursor reuses the same rendering and fade behavior; snapshots remain shared by session. Optional agent profiles override presentation only, and session disable/end removes every cursor.

### Headless Ref Action
A ref-based action that uses semantic accessibility operations without implicit focus stealing, cursor movement, synthetic keyboard input, or pasteboard use. This is the default mode.

Headless ref actions may still fail when the native accessibility API cannot perform the requested semantic operation; they fail closed with structured actionability or policy errors rather than silently substituting physical input. The broader **headed** policy must be selected explicitly with `--headed`.

### Action Chain
The ordered ladder of strategies a ref action walks to perform one intent, with each step gated by policy and its delivery evidence recorded. The order is action-specific: natural input may put a headed physical step first, while semantic state changes use accessibility actions or settable attributes only.

The chain pins one execution deadline at its start (distinct from the Resolver Deadline, which budgets re-identification) and every step observes it. Expiry while a step may have partially mutated the element surfaces as a structured timeout carrying the observed state, never as a plain step failure. The caller must be able to tell "nothing happened" from "something may have happened".

### Wait Predicate
The condition a wait command polls for before returning, such as element actionability, text presence, window appearance, menu state, or notification arrival.

### Resolver Deadline
The remaining time budget carried through strict ref resolution so every native read can fail with a structured timeout instead of using an unrelated platform default timeout.

### Coordinate Fallback
An explicit opt-in path that uses screen coordinates or physical input when semantic accessibility operations cannot perform the requested action.

Ref-targeted physical input lands on the topmost window at the resolved point, so core first ensures the target element's exact window is frontmost. The app being frontmost is not sufficient when the element lives in a background window of that app.

Raw `--xy` input carries no window identity: it moves or clicks at the requested coordinates and focuses no application. Ref-addressed drag pickup resolves the element's bounds center. On a slider the thumb is rarely at the center, so center pickup can miss it; headed `--from-xy` with a thumb-row offset is the workaround until slider-aware pickup exists (the drag probe in A4-3 picks the thumb up at the left end of the track, 14 px below its top, not at the center).

### Release Guard
An arm-before-commit guard on multi-event physical sequences (drag, modifier chord, chunked text) that posts corrective input at the origin on abort: drag-back plus mouse-up for a drag, key-up sweep for held keys and modifiers.

Cleanup is best-effort: if the OS does not acknowledge the corrective events, the error preserves that uncertainty (`emergency_release_posted`, `delivered_unverified`, `delivered_events` count) rather than claiming no input landed. The contract is ported from macOS; Windows uses `SendInput` and Linux its X11/Wayland sinks under the same discipline (A20-3).

### Foreground Gate
The precondition that ref-addressed physical injection runs only while the target window the headed pipeline established is still foreground.

Windows `SendInput` injects into the foreground input queue with no per-pid targeting (A4-2), so ref-addressed keyboard paths also verify the element still holds keyboard focus (`HasKeyboardFocus`) before injecting. Bare `--xy` commands sit outside this gate: the caller owns the coordinate and `--headed` is their guard (see Interaction Policy).

### Integrity Boundary
The User Interface Privilege Isolation boundary where observation reads cross to a higher-integrity target but input writes do not land (A9-2).

Detection is a token-integrity comparison via `GetTokenInformation(TokenIntegrityLevel)`, never the `SendInput` return value, because the API reports success in both blocked and unblocked arms (A9-3). A target strictly higher than the caller maps to `PERM_DENIED`. Detection is proven locally (A20-1); the cross-boundary input effect was measured live on a split-integrity rig (A24-16), where Medium-to-High `set-value` and `type` fail closed. A19-4 and A20-2 record the earlier hosts where elevation manufacture was unavailable and the effect could not be measured.

### Physical Synthesis
The low-level OS input primitive behind headed commands: `SendInput` on Windows, `CGEvent` on macOS, XTest on X11 and the Mutter RemoteDesktop session on Wayland.

Delivery is best-effort and judged by independent re-read where available; interrupted sequences end in a known safe state via a release guard. Held edges (`key-down`/`key-up`, `mouse-down`/`mouse-up`) reject until a daemon owns the hold lifetime. Standalone `key_event` rejects honestly on every platform.

### FFI Ref-Action Parity
The requirement that language bindings using refs follow the same strict resolution, actionability, and interaction-policy semantics as CLI ref commands.

## Platform Evidence

### Probe Corpus
The committed, re-runnable set of raw platform scripts a platform's exploration work uses to observe real OS behavior before any adapter code for that platform exists.

On Linux only the ledger (`probes/linux/FINDINGS.md`) is committed; its probe scripts and captures are kept outside the repository.

Probes write their captures beside the scripts and never modify product code, so the corpus can be re-run years later against a changed OS and its answers compared with what was originally observed.

### Capture
One probe pass's committed output: a redacted, machine-readable record of what the OS actually did, stored beside the probe that produced it and cited by the findings ledger.

Every capture is written beside a normalized twin (regenerated on every run and git-ignored) whose run-varying values (handles, process and thread ids, timings, coordinates beyond a fixed tolerance) are canonicalized, so re-running the corpus later diffs empty unless the platform genuinely changed. A non-empty diff is real drift, which is what a later re-runner needs to see.

### Placeholder Capture
A file written where a capture should be, recording that a pass did not run or produced nothing, as distinct from a capture whose content is a negative result.

Recording that nothing was found is data. Recording that nothing was looked at is not. A placeholder satisfies any check that asks only whether an artifact exists, which is how a run that measured nothing reports success.

### Redaction Gate
The mandatory pass every capture is written through, replacing the operator's identity (user name, machine and host names, profile paths, the machine-unique parts of security identifiers) with stable placeholders so evidence can be committed.

The gate covers operator identity and nothing else. Reducing a content node's own text (a document title, someone's file name showing through the accessibility tree) is the probe author's job at the call site, in whatever language the probe is written; assuming the gate does it is how private content reaches a committed capture.

### Census
A measurement that tallies how often something occurs across a whole real application tree (which control kinds appear, how many carry an identifier, what actions and states are observed under each), committed in place of a per-node dump.

Preferred because a full dump repeats itself hundreds of times over and most of its per-node values cannot be asserted against at all; the tally is what a reviewer can judge a mapping by.

### Findings Ledger
The document inside a probe corpus mapping every experiment to what was observed, the client stack and environment that produced it, and a verdict (`CONFIRMS`, `CONTRADICTS`, `NEW-EDGE` or `DEFERRED`) against what the project assumed before the measurement.

A contradicting verdict is a defect in whatever assumed otherwise and is corrected in the same change that discovered it. Each row carries a stable id naming its area and its position in that area (`A15-7` on Windows, `L32-39` on Linux), and that id is the project's citation form for a measurement: a row id stays true however the code or the docs move, so shipped source may cite one the way it would cite a CVE.

### Dev Box
The single interactive development machine a probe corpus runs on, whose full environment is recorded once in the ledger so every row is read against it.

A number measured only here is a fact about this machine, not about the design. Repetition removes noise but never removes environment, and a result that looked like a design win on the dev box alone has already turned out to be a dev-box artifact once.

### Hosted Runner
The ephemeral CI machine a probe is re-run on, differing from the dev box in core count, power profile and contention, and therefore the second environment a cost or capability claim must survive before it is written down as fact.

Every run and every capture is labelled with which of the two produced it, so a reader comparing two numbers never has to guess whether they are comparable.

## Verification And Dogfooding

### Mandatory Measurement Gate
A probe run's own assertion that it produced every measurement it declared it would, failing the run when a declared capture is missing or turns out to be a placeholder.

Declaring nothing fails too, and for the same reason: a run that asserted nothing is indistinguishable from a clean one, so an empty declaration is reported as a gap in its own right rather than passing vacuously. The gap is computed on every run, and enforced where no human is reading the output.

### Gate Self-Test
A committed fixture an automated verification check runs against itself before every real scan, so a check that has quietly stopped detecting anything fails loudly instead of reporting a clean tree.

Two rules make it worth having. The fixture must invoke the same rule declaration the real scan invokes (a shared program text, never a copied pattern), or it proves only that the copy still agrees with itself while the shipped rule drifts away from both. And it must cover the check's ability to run at all, not merely its rule: a gate whose interpreter is absent, whose file never got its executable bit, or whose regex dialect is a silent no-op on the platform that actually runs it exits clean and is indistinguishable from a passing tree. Finding nothing is a failure, never a skip.

The fixture has two halves, the must-catch lines the rule is required to flag and the must-pass lines it is required to leave alone, and both matter in opposite directions: a rule loosened until the very case it exists to catch escapes fails the must-catch half, a rule tightened until innocent text trips it fails the must-pass half. Every fixture line is run through every rule collectively, so a newly added rule is checked against the old lines it must not start breaking.

### Dogfood Run
Driving the shipped release binary against real software nobody in this repository wrote and judging it by reading its output, because correctness against real providers is not something a runner-hosted assertion can encode.

This is where a platform adapter's correctness is established; a green build proves totality and wiring, not that a mapping is right. Anything the run could not exercise is reported as unexercised rather than presented as verified, and every target shows content the repository controls so the run can be repeated and reviewed.

### Dogfood Report
The judged record of one dogfood run, kept outside version control: its environment, its target matrix, its per-target judgements, what it fixed, and what it left open.

The run is the measurement and the report is bookkeeping over it; neither substitutes for the other. A run with no report leaves the next maintainer nothing to read, and writing a report is not itself a measurement. What makes a claim in one trustworthy is the run behind it, so a report states what was exercised and what was not rather than reading as uniform verification. Anything the run leaves unmeasured is also recorded where its owner will see it (a test, a ledger row, or the owning doc), because the report itself is not committed.

## Relationships

A session owns one latest-snapshot pointer, a trace directory written only while its manifest enables tracing, and persisted snapshot refmaps. A snapshot persists a ref map and can be selected by ID within that same namespace. A ref resolves through strict ref resolution into live native evidence, then actionability decides whether the action can safely dispatch. In headed mode, core applies the action's focus/cursor requirement before the platform adapter executes the action-specific chain under its own deadline. FFI ref-action parity keeps that same relationship true for language bindings. Every native read along that path lands on one of the read outcomes, and it is the outcome, not the error text, that decides whether the resolver retries within its deadline or stops.

Evidence flows the other way. A probe writes captures, the findings ledger cites them by row id, a contradicting row corrects the docs and code that assumed otherwise, and the adapter is then built against measured behavior. What the corpus cannot settle, a dogfood run does against real software, and its findings are fixed, recorded in a ledger row, or accepted with a reason. The mandatory measurement gate and gate self-tests exist so that neither a probe run nor a verification check can report success having asserted nothing.
