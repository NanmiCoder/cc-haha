//
//  Injection.swift
//  cu-helper
//
//  THE input injection engine for the native Computer Use helper.
//
//  ──────────────────────────────────────────────────────────────────────────
//  ABSOLUTE RULE — read before touching anything in this file:
//
//    Every mouse/keyboard event is delivered with `CGEvent.postToPid(_:)`
//    (the Swift veneer over `CGEventPostToPid`). We NEVER call
//    `CGEvent.post(tap: .cghidEventTap)` / `CGEventPost(.cghidEventTap, …)`,
//    and we NEVER call `CGWarpMouseCursorPosition` /
//    `CGDisplayMoveCursorToPoint` / any `NSEvent` mouse-warp.
//
//    Moving the one real system cursor is precisely the bug this rewrite
//    removes: the user must keep their physical mouse free at all times.
//    The visible "cursor" the AI drives is the VirtualCursor overlay window
//    (see VirtualCursor.swift); the real OS cursor is never touched here.
//
//    Mouse events still carry a `mouseCursorPosition` — but that is only the
//    *event location* stamped on the synthetic event so the receiving app
//    hit-tests the right control. Posting an event to a pid with a location
//    does NOT move the hardware cursor; only an explicit warp would.
//  ──────────────────────────────────────────────────────────────────────────
//
//  TCC reality: real cross-app clicks/typing require Accessibility permission
//  granted to THIS signed binary in System Settings ▸ Privacy & Security ▸
//  Accessibility. `ensurePostable` enforces `AXIsProcessTrusted()` before
//  posting to any pid other than our own (self-posting is allowed untrusted so
//  the daemon/CLI self-test can validate the CGEvent construction + postToPid
//  path without any grant). When not trusted we throw `CUError("not_trusted")`,
//  which the bridge surfaces verbatim.
//
//  Coordinate contract: every (x, y) arriving here is ALREADY a logical
//  top-left point in the global display space (the TS layer scaled it). We use
//  the values verbatim — no scaleFactor, no flip, no warp.
//

import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import Foundation

// MARK: - MouseButton

/// The five buttons the contract exposes. `cg`/`down`/`up`/`dragged` map to
/// the CoreGraphics event vocabulary so the call sites stay declarative.
public enum MouseButton: String, Sendable, Equatable {
    case left
    case right
    case middle
    case back
    case forward

    /// The `.…MouseDown` event type for this button.
    var down: CGEventType {
        switch self {
        case .left: return .leftMouseDown
        case .right: return .rightMouseDown
        case .middle, .back, .forward: return .otherMouseDown
        }
    }

    /// The `.…MouseUp` event type for this button.
    var up: CGEventType {
        switch self {
        case .left: return .leftMouseUp
        case .right: return .rightMouseUp
        case .middle, .back, .forward: return .otherMouseUp
        }
    }

    /// The `.…MouseDragged` event type for this button.
    var dragged: CGEventType {
        switch self {
        case .left: return .leftMouseDragged
        case .right: return .rightMouseDragged
        case .middle, .back, .forward: return .otherMouseDragged
        }
    }

    /// The `CGMouseButton` enum value (needed for the `mouseButton:` arg and
    /// for `.otherMouse*` events to disambiguate which "other" button).
    var cg: CGMouseButton {
        switch self {
        case .left: return .left
        case .right: return .right
        case .middle: return .center
        case .back: return CGMouseButton(rawValue: 3)!
        case .forward: return CGMouseButton(rawValue: 4)!
        }
    }

    /// Tolerant parse of the TS-side button string. Defaults to `.left`.
    static func parse(_ raw: String?) -> MouseButton {
        switch (raw ?? "left").lowercased() {
        case "right": return .right
        case "middle", "center": return .middle
        default: return .left
        }
    }
}

// MARK: - Held-state tracking (for releaseAllHeld on teardown)

/// A release attempt never consumes its teardown record implicitly. Callers
/// remove a record only after the matching up event was allocated and posted.
struct HeldReleaseLedger<Record: Equatable> {
    private(set) var records: [Record] = []

    mutating func append(_ record: Record) {
        records.append(record)
    }

    func last(where predicate: (Record) -> Bool) -> Record? {
        records.last(where: predicate)
    }

    mutating func complete(_ record: Record) {
        guard let index = records.lastIndex(of: record) else { return }
        records.remove(at: index)
    }

    mutating func removeAll() {
        records.removeAll()
    }
}

private struct HeldButtonRecord: Equatable {
    let button: MouseButton
    let point: CGPoint
    let target: ProvenProcessTarget
}

private struct HeldKeyRecord: Equatable {
    let code: CGKeyCode
    let target: ProvenProcessTarget
}

private struct MouseBurstSpec {
    let type: CGEventType
    let point: CGPoint
    let button: MouseButton
    let clickState: Int
}

/// Tracks synthetic key/button state we have pressed but not yet released, so
/// the daemon can guarantee a clean slate on disconnect/shutdown and a crashed
/// agent loop never leaves a modifier or mouse button stuck "down" in the
/// target app. Lives on the main actor because all injection is main-actor.
@MainActor
private enum HeldState {
    /// keycodes currently held down via `holdKey` (in press order).
    static var keys = HeldReleaseLedger<HeldKeyRecord>()
    /// mouse buttons currently held down via `mouseDown`, with the location
    /// they were pressed at and the pid they were posted to (so the matching
    /// release goes to the same process even if the frontmost app changed).
    static var buttons = HeldReleaseLedger<HeldButtonRecord>()
}

// MARK: - Injection

/// Stateless (apart from `HeldState`) façade over CoreGraphics event posting.
/// `@MainActor` because synthetic events must be posted in main-run-loop order
/// to interleave correctly with the overlay's CADisplayLink animation, and
/// because the AppKit/CGWindowList target resolution touches `NSWorkspace`.
@MainActor
public enum Injection {

    #if DEBUG
    /// Test-only observation of the exact immutable values used by the safety
    /// check. It cannot replace either identity or change validation policy.
    static var targetValidationObserver: ((ProvenProcessTarget, AXTreeProcessIdentity?) -> Void)?
    #endif

    /// One shared event source per process, in the HID system state so the
    /// synthesized events inherit the real keyboard/modifier baseline. May be
    /// nil in extremely locked-down sandboxes; call sites throw `event_alloc`.
    static let source: CGEventSource? = HelperEventMarker.mark(
        CGEventSource(stateID: .hidSystemState)
    )

    /// Immutable process-lifetime evidence written only by a real resolver.
    /// Daemon visuals must validate this pair and never reinterpret a recycled
    /// pid as a newly resolved target.
    private(set) static var lastResolvedTarget: ProvenProcessTarget?

    static var lastResolvedTargetPid: pid_t? { lastResolvedTarget?.pid }

    @discardableResult
    static func recordResolvedTarget(_ pid: pid_t) -> ProvenProcessTarget? {
        let target = try? authorizeResolvedTarget(pid: pid)
        lastResolvedTarget = target
        return target
    }

    static func recordResolvedTarget(_ target: ProvenProcessTarget) {
        lastResolvedTarget = target
    }

    static func clearResolvedTarget() {
        lastResolvedTarget = nil
    }

    /// Read-only synthetic input ledger for internal live-smoke diagnostics.
    /// This reports only downs posted by this helper, never physical keyboard
    /// or mouse state.
    static func heldInputState() -> JSONValue {
        let keys = HeldState.keys.records.map { held in
            JSONValue.object([
                "keyCode": .int(Int(held.code)),
                "pid": .int(Int(held.target.pid)),
            ])
        }
        let buttons = HeldState.buttons.records.map { held in
            JSONValue.object([
                "button": .string(held.button.rawValue),
                "pid": .int(Int(held.target.pid)),
                "x": .double(held.point.x),
                "y": .double(held.point.y),
            ])
        }
        return .object([
            "keys": .array(keys),
            "buttons": .array(buttons),
        ])
    }

    // Inter-event spacing. Small, on the main actor, via Task.sleep — NEVER
    // `usleep`, which would block the run loop and freeze the overlay glide.
    private static let interClickGapMs: UInt64 = 80    // matches mac_helper interval=0.08

    /// Hold time between a button's press and its release.
    ///
    /// A zero-duration press is not something a hand can produce, and UI that
    /// measures press duration (drag thresholds, press-and-hold affordances,
    /// some Chromium hit-tests) can discard it. The reference implementation
    /// carries the same "human click interval" between down and up.
    private static let pressHoldMs: UInt64 = 24

    /// Share the semantic input path's focus lifecycle and acknowledgement.
    private static func focusForClick(pid: pid_t) async throws {
        try await SyntheticWindowFocus.prepareInput(pid: pid)
    }
    private static let interKeyGapMs: UInt64 = 6       // between down/up of a single key
    private static let interGraphemeGapMs: UInt64 = 4  // between typed characters

    private static func sleepMs(_ ms: UInt64) async {
        guard ms > 0 else { return }
        try? await Task.sleep(nanoseconds: ms * 1_000_000)
    }

    // MARK: Target resolution

    /// Resolve which process should receive an event.
    ///
    /// - For coordinate ops, pass the logical point: we hit-test the on-screen
    ///   window list (topmost window whose bounds contain the point) and map
    ///   its owner pid. This is what makes the event land in the app the user
    ///   sees under the virtual cursor, even when it is not frontmost.
    /// - For keyboard ops, pass `nil`: we target the frontmost application.
    ///
    /// Throws `CUError("no_target")` when no suitable pid is found (0/invalid).
    public static func resolveTargetPid(atLogical p: CGPoint?) throws -> pid_t {
        try resolveTarget(atLogical: p, allowFrontmostFallback: true).pid
    }

    /// Exact coordinate target for decomposed legacy mouse actions. A desktop
    /// gap must fail closed rather than guessing whichever app is frontmost.
    static func resolveExactCoordinateTarget(
        atLogical point: CGPoint
    ) throws -> ProvenProcessTarget {
        try resolveTarget(
            atLogical: point,
            allowFrontmostFallback: false
        )
    }

    private static func resolveTarget(
        atLogical p: CGPoint?,
        allowFrontmostFallback: Bool
    ) throws -> ProvenProcessTarget {
        if let point = p {
            if let pid = topmostWindowOwnerPid(at: point), pid > 0 {
                let target = try authorizeResolvedTarget(pid: pid)
                recordResolvedTarget(target)
                return target
            }
            guard allowFrontmostFallback else {
                throw CUError(
                    "no_target",
                    "No exact target application window exists under the point"
                )
            }
        }
        if let front = NSWorkspace.shared.frontmostApplication,
           front.processIdentifier != getpid() {
            let pid = front.processIdentifier
            if pid > 0 {
                let target = try authorizeResolvedTarget(pid: pid)
                recordResolvedTarget(target)
                return target
            }
        }
        throw CUError("no_target", "No target application under point and no frontmost application")
    }

    /// Resolve the target pid for a KEYBOARD op (`type` / `key` / `hold_key`).
    ///
    /// Prefers the pid of the app the most recent COORDINATE injection drove
    /// (`lastResolvedTargetPid`) so the canonical "click a field, then type"
    /// lands the text in THAT app — even when the frontmost app is the host
    /// (Claude Code Haha) or some other window. Posting keyboard events to the
    /// frontmost app (the old behavior) is exactly why typed text went nowhere /
    /// to the wrong window when the driven app wasn't frontmost.
    ///
    /// Falls back to the frontmost application only when there is no remembered
    /// target (a pure-keyboard macro with no preceding click) or the remembered
    /// target has since quit. Note we deliberately DON'T overwrite a good
    /// `lastResolvedTargetPid` with the frontmost here, so the capture glow stays
    /// aimed at the driven app rather than being poisoned by a keyboard op.
    public static func resolveKeyboardTargetPid() throws -> pid_t {
        try resolveKeyboardTarget().pid
    }

    static func resolveKeyboardTarget() throws -> ProvenProcessTarget {
        if let target = lastResolvedTarget,
           target.pid != getpid(),
           target.validatedPid(
               currentIdentity: AXTree.currentProcessIdentity(pid: target.pid)
           ) != nil {
            let authorized = try validateAuthorizedTarget(target)
            recordResolvedTarget(authorized)
            return authorized
        }
        clearResolvedTarget()
        return try resolveTarget(
            atLogical: nil,
            allowFrontmostFallback: true
        )
    }

    /// Authoritative native bundle policy after a real pid has resolved.
    static func authorizeResolvedTarget(
        pid: pid_t,
        expectedBundleID: String? = nil
    ) throws -> ProvenProcessTarget {
        try ResolvedTargetAuthorization.authorize(
            pid: pid,
            identity: AXTree.currentProcessIdentity(pid: pid),
            expectedBundleID: expectedBundleID
        )
    }

    /// Revalidate an already-proven resolver pair without recapturing a recycled
    /// pid as a new target.
    static func validateAuthorizedTarget(
        _ target: ProvenProcessTarget
    ) throws -> ProvenProcessTarget {
        let currentIdentity = AXTree.currentProcessIdentity(pid: target.pid)
        #if DEBUG
        targetValidationObserver?(target, currentIdentity)
        #endif
        guard target.validatedPid(currentIdentity: currentIdentity) != nil else {
            throw CUError(
                "stale_process",
                "The target application changed process identity before the action."
            )
        }
        return try ResolvedTargetAuthorization.authorize(
            pid: target.pid,
            identity: currentIdentity,
            expectedBundleID: target.identity.bundleID
        )
    }

    static func heldButtonTarget(_ button: MouseButton) -> ProvenProcessTarget? {
        HeldState.buttons.last(where: { $0.button == button })?.target
    }

    /// Topmost (visually frontmost) on-screen window owner at a global,
    /// top-left logical point. Uses the shared `Displays.onScreenWindows()`
    /// snapshot (already filtered to on-screen, desktop elements excluded) so
    /// the window-layer ordering matches what the user sees. CGWindowList is
    /// returned front-to-back, so the FIRST containing window wins.
    private static func topmostWindowOwnerPid(at point: CGPoint) -> pid_t? {
        let windows = Displays.onScreenWindows()
        for win in windows {
            // Skip our own overlay windows defensively (they are click-through
            // and ignore mouse events, but they must never absorb a hit-test).
            if win.ownerPID == getpid() { continue }
            if win.bounds.contains(point) {
                return win.ownerPID
            }
        }
        return nil
    }

    /// Validate that `pid` is a live process we are permitted to post to.
    ///
    /// Posting to our OWN pid is always allowed (used by the self-test path)
    /// even without Accessibility — the OS lets a process inject into itself.
    /// For any other pid we require both:
    ///   * the process is still alive (`NSRunningApplication`), and
    ///   * `AXIsProcessTrusted()` is true for this helper binary,
    /// otherwise `CUError("not_trusted")`.
    public static func ensurePostable(_ pid: pid_t) throws {
        if pid == getpid() { return }
        guard pid > 0, NSRunningApplication(processIdentifier: pid) != nil else {
            throw CUError("no_target", "Target process \(pid) is not running")
        }
        guard AXIsProcessTrusted() else {
            throw CUError(
                "not_trusted",
                "Accessibility permission is required. Grant it to cu-helper in System Settings ▸ Privacy & Security ▸ Accessibility."
            )
        }
    }

    private static func eventSource() throws -> CGEventSource {
        guard let src = source else {
            throw CUError("event_alloc", "Failed to create CGEventSource(.hidSystemState)")
        }
        return src
    }

    /// Build one mouse event, bound to the window under `point` whenever that
    /// window can be identified.
    ///
    /// The window binding is the difference between working and silently doing
    /// nothing on Chromium/CEF apps: those route input by the window an event
    /// claims, and a bare `CGEvent` claims none. See WindowTargetedEvent.
    /// Native AppKit apps re-hit-test and are unaffected either way, so the
    /// window-bound event is simply the better event for every target.
    ///
    /// Falls back to the plain CGEvent when AppKit will not vend one — a
    /// window-less event is what we shipped before, so the fallback can only
    /// match the old behaviour, never regress past it.
    private static func makeMouse(
        _ type: CGEventType,
        at point: CGPoint,
        button: MouseButton,
        clickState: Int? = nil,
        targetPid: pid_t? = nil
    ) throws -> CGEvent {
        let clicks = max(1, clickState ?? 1)
        if let nsType = Self.nsEventType(for: type),
           let pid = targetPid,
           let window = WindowGeometry.window(at: point, pid: pid) {
            // Focus is NOT arranged here: this is synchronous, and the target
            // needs a moment to dequeue the notification before the burst
            // arrives (see `focusForClick`). Callers send it up front and await
            // the settle.
            if let event = WindowTargetedEvent.makeMouseEvent(
                type: type,
                nsType: nsType,
                point: point,
                button: button,
                clickCount: clicks,
                windowID: window.id,
                windowBounds: window.bounds
            ) {
                if let cs = clickState {
                    event.setIntegerValueField(.mouseEventClickState, value: Int64(cs))
                }
                return event
            }
        }

        let src = try eventSource()
        guard let event = CGEvent(
            mouseEventSource: src,
            mouseType: type,
            mouseCursorPosition: point,  // event location only — NOT a warp
            mouseButton: button.cg
        ) else {
            throw CUError("event_alloc", "Failed to allocate mouse event")
        }
        if let cs = clickState {
            event.setIntegerValueField(.mouseEventClickState, value: Int64(cs))
        }
        return event
    }

    /// CGEventType → the NSEvent type AppKit needs to vend a window-numbered
    /// event. Only mouse types map; anything else has no window-bound form.
    nonisolated static func nsEventType(for type: CGEventType) -> NSEvent.EventType? {
        switch type {
        case .leftMouseDown: return .leftMouseDown
        case .leftMouseUp: return .leftMouseUp
        case .rightMouseDown: return .rightMouseDown
        case .rightMouseUp: return .rightMouseUp
        case .otherMouseDown: return .otherMouseDown
        case .otherMouseUp: return .otherMouseUp
        case .mouseMoved: return .mouseMoved
        case .leftMouseDragged: return .leftMouseDragged
        case .rightMouseDragged: return .rightMouseDragged
        case .otherMouseDragged: return .otherMouseDragged
        default: return nil
        }
    }

    // MARK: Click

    /// Synthesize a click of `count` (1=single, 2=double, 3=triple) of `button`
    /// at the logical point, with optional modifier flags held for the press.
    ///
    /// We post `count` down/up PAIRS, stamping `.mouseEventClickState` 1…count
    /// on BOTH the down and the up of each pair — that is how AppKit
    /// distinguishes a double/triple-click from N independent single clicks
    /// (NSEvent.clickCount is read from this field). Modifier flags are applied
    /// to every event so e.g. cmd-click selects.
    public static func click(
        x: Double,
        y: Double,
        button: MouseButton,
        count: Int,
        modifiers: [String]
    ) async throws {
        let point = CGPoint(x: x, y: y)
        let pid = try resolveTargetPid(atLogical: point)
        try await click(pid: pid, x: x, y: y, button: button, count: count, modifiers: modifiers)
    }

    /// Target-aware click used when an upstream resolver already selected the
    /// process. This overload never re-routes based on the coordinate.
    public static func click(
        pid: pid_t,
        x: Double,
        y: Double,
        button: MouseButton,
        count: Int,
        modifiers: [String]
    ) async throws {
        let targetPid = try TargetRoutingPolicy.pid(explicit: pid, coordinateOwner: nil)
        let target = try authorizeResolvedTarget(pid: targetPid)
        recordResolvedTarget(target)
        try ensurePostable(targetPid)

        let point = CGPoint(x: x, y: y)
        let clicks = max(1, count)
        let flags = KeySym.flags(for: modifiers)

        try await focusForClick(pid: targetPid)

        let specs = (1...clicks).flatMap { clickState in
            [
                MouseBurstSpec(
                    type: button.down,
                    point: point,
                    button: button,
                    clickState: clickState
                ),
                MouseBurstSpec(
                    type: button.up,
                    point: point,
                    button: button,
                    clickState: clickState
                ),
            ]
        }
        let events: [CGEvent] = try EventBurst.allocateAll(
            specs: specs
        ) { spec in
            let event = try makeMouse(
                spec.type,
                at: spec.point,
                button: spec.button,
                clickState: spec.clickState,
                targetPid: targetPid
            )
            if !flags.isEmpty { event.flags = flags }
            return event
        }

        for clickIndex in 0..<clicks {
            // Timestamp at send time, not allocation time: the burst is built up
            // front so a mid-burst failure cannot strand a held button, but a
            // stale timestamp makes the press look like it happened in the past.
            WindowTargetedEvent.post(events[clickIndex * 2], to: targetPid)
            await sleepMs(pressHoldMs)
            WindowTargetedEvent.post(events[clickIndex * 2 + 1], to: targetPid)
            if clickIndex < clicks - 1 {
                await sleepMs(interClickGapMs)
            }
        }
    }

    // MARK: Decomposed press / release

    /// Press (and hold) `button` at the given logical point. Used by the
    /// `mouse_down` verb and as the first half of an interactive drag the model
    /// performs across multiple commands. The held button is tracked so
    /// `releaseAllHeld` can clean it up if the loop is interrupted.
    public static func mouseDown(_ button: MouseButton, at p: CGPoint) async throws {
        let target = try resolveExactCoordinateTarget(atLogical: p)
        try await mouseDown(button, at: p, target: target)
    }

    static func mouseDown(
        _ button: MouseButton,
        at p: CGPoint,
        target: ProvenProcessTarget
    ) async throws {
        let target = try validateAuthorizedTarget(target)
        recordResolvedTarget(target)
        try ensurePostable(target.pid)
        // A press starts an interaction, so the target has to believe it holds
        // focus before it arrives — otherwise the press is discarded and the
        // matching release lands on nothing.
        try await focusForClick(pid: target.pid)
        let event = try makeMouse(button.down, at: p, button: button, clickState: 1, targetPid: target.pid)
        event.postToPid(target.pid)
        HeldState.buttons.append(
            HeldButtonRecord(button: button, point: p, target: target)
        )
    }

    /// Release `button` at the given logical point. Posts to the same pid the
    /// matching `mouseDown` used when we have a record of it (so a drag started
    /// on a non-frontmost window still completes there); otherwise resolves the
    /// pid fresh under the release point.
    public static func mouseUp(_ button: MouseButton, at p: CGPoint) async throws {
        let target: ProvenProcessTarget
        if let held = heldButtonTarget(button) {
            target = held
        } else {
            target = try resolveExactCoordinateTarget(atLogical: p)
        }
        try await mouseUp(button, at: p, target: target)
    }

    static func mouseUp(
        _ button: MouseButton,
        at p: CGPoint,
        target requestedTarget: ProvenProcessTarget
    ) async throws {
        let target: ProvenProcessTarget
        let heldRecord = HeldState.buttons.last(where: { $0.button == button })
        if let held = heldRecord {
            guard held.target == requestedTarget else {
                throw CUError(
                    "stale_process",
                    "The held mouse button belongs to a different process lifetime."
                )
            }
            target = held.target
        } else {
            target = requestedTarget
        }
        let validated = try validateAuthorizedTarget(target)
        recordResolvedTarget(validated)
        try ensurePostable(validated.pid)
        let event = try makeMouse(button.up, at: p, button: button, clickState: 1, targetPid: validated.pid)
        event.postToPid(validated.pid)
        // Retain the teardown record through every throwing path. Only a fully
        // allocated and posted up event completes the held release.
        if let heldRecord {
            HeldState.buttons.complete(heldRecord)
        }
    }

    // MARK: Drag

    /// Press at `from`, emit `steps` interpolated drag events along the
    /// straight line to `to`, then release at `to`. All events go to the pid
    /// resolved AT `from` (the drag belongs to the window it started over, even
    /// if the path crosses another window). Mirrors a 0.2s pyautogui dragTo.
    public static func drag(
        from: CGPoint,
        to: CGPoint,
        button: MouseButton,
        steps: Int
    ) async throws {
        let pid = try resolveTargetPid(atLogical: from)
        try await drag(pid: pid, from: from, to: to, button: button, steps: steps)
    }

    /// Target-aware drag used when an upstream resolver already selected the
    /// process. Every event in the gesture is posted to that same pid.
    public static func drag(
        pid: pid_t,
        from: CGPoint,
        to: CGPoint,
        button: MouseButton,
        steps: Int
    ) async throws {
        let targetPid = try TargetRoutingPolicy.pid(explicit: pid, coordinateOwner: nil)
        let target = try authorizeResolvedTarget(pid: targetPid)
        recordResolvedTarget(target)
        try ensurePostable(targetPid)

        let n = max(1, steps)
        try await focusForClick(pid: targetPid)

        var specs = [
            MouseBurstSpec(
                type: button.down,
                point: from,
                button: button,
                clickState: 1
            ),
        ]
        for step in 1...n {
            let t = Double(step) / Double(n)
            specs.append(MouseBurstSpec(
                type: button.dragged,
                point: CGPoint(
                    x: from.x + (to.x - from.x) * t,
                    y: from.y + (to.y - from.y) * t
                ),
                button: button,
                clickState: 1
            ))
        }
        specs.append(MouseBurstSpec(
            type: button.up,
            point: to,
            button: button,
            clickState: 1
        ))

        let events: [CGEvent] = try EventBurst.allocateAll(
            specs: specs
        ) { spec in
            try makeMouse(
                spec.type,
                at: spec.point,
                button: spec.button,
                clickState: spec.clickState,
                targetPid: targetPid
            )
        }

        events[0].postToPid(targetPid)
        for index in 1...n {
            events[index].postToPid(targetPid)
            if n > 1 {
                await sleepMs(6)
            }
        }
        events[n + 1].postToPid(targetPid)
    }

    // MARK: Scroll

    /// Pixel-unit scroll at the logical point. `wheel1` is the VERTICAL axis
    /// and `wheel2` the HORIZONTAL axis (per CGEvent's scrollWheelEvent2 ABI),
    /// matching mac_helper's `scroll(deltaY)` / `hscroll(deltaX)` split.
    ///
    /// Sign convention note: positive `wheel1` scrolls content up (classic
    /// direction). With macOS "natural scrolling" enabled the perceived
    /// direction inverts — this is a system preference applied by the target,
    /// not something we can detect here, so the manual checklist verifies the
    /// sign against a real scroll view and flips it if a regression appears.
    public static func scroll(
        x: Double,
        y: Double,
        deltaX: Int,
        deltaY: Int
    ) async throws {
        let point = CGPoint(x: x, y: y)
        let pid = try resolveTargetPid(atLogical: point)
        try await scroll(pid: pid, x: x, y: y, deltaX: deltaX, deltaY: deltaY)
    }

    /// Target-aware scroll used when an upstream resolver already selected the
    /// process. The event location is metadata, never a routing input.
    public static func scroll(
        pid: pid_t,
        x: Double,
        y: Double,
        deltaX: Int,
        deltaY: Int
    ) async throws {
        let targetPid = try TargetRoutingPolicy.pid(explicit: pid, coordinateOwner: nil)
        let target = try authorizeResolvedTarget(pid: targetPid)
        recordResolvedTarget(target)
        try ensurePostable(targetPid)

        let point = CGPoint(x: x, y: y)
        let src = try eventSource()
        guard let event = CGEvent(
            scrollWheelEvent2Source: src,
            units: .pixel,
            wheelCount: 2,
            wheel1: Int32(clampingToInt32(deltaY)),
            wheel2: Int32(clampingToInt32(deltaX)),
            wheel3: 0
        ) else {
            throw CUError("event_alloc", "Failed to allocate scroll event")
        }
        // Scroll wheel events are not positional, but stamping the location
        // keeps the event consistent for apps that read it.
        event.location = point
        event.postToPid(targetPid)
    }

    // MARK: Key sequences

    /// Post an xdotool-style key sequence (e.g. `"cmd+shift+a"`, `"Return"`,
    /// `"ctrl+c"`) to the frontmost application, `count` times.
    ///
    /// The sequence is split on `+`: every token but the last is a modifier
    /// (contributing to `CGEventFlags`); the last token is the key, resolved
    /// via the `KeySym` table or, failing that, the current keyboard layout
    /// (`UCKeyTranslate` reverse-map). For each repeat we post keyDown with the
    /// modifier flags set, then keyUp with the flags cleared.
    public static func key(_ sequence: String, repeat count: Int) async throws {
        let target = try resolveKeyboardTarget()
        try await key(
            sequence,
            repeat: count,
            target: target
        )
    }

    static func key(
        _ sequence: String,
        repeat count: Int,
        target requestedTarget: ProvenProcessTarget
    ) async throws {
        let (flags, keyCode) = try KeySym.parse(sequence)
        let target = try validateAuthorizedTarget(requestedTarget)
        recordResolvedTarget(target)
        try ensurePostable(target.pid)
        let src = try eventSource()
        let reps = max(1, count)

        for i in 0..<reps {
            guard let down = CGEvent(keyboardEventSource: src, virtualKey: keyCode, keyDown: true) else {
                throw CUError("event_alloc", "Failed to allocate key-down event")
            }
            if !flags.isEmpty { down.flags = flags }
            down.postToPid(target.pid)

            await sleepMs(interKeyGapMs)

            guard let up = CGEvent(keyboardEventSource: src, virtualKey: keyCode, keyDown: false) else {
                throw CUError("event_alloc", "Failed to allocate key-up event")
            }
            // Clear the modifier flags on the up stroke so we never leave a
            // modifier latched in the target's view of the keyboard.
            up.flags = []
            up.postToPid(target.pid)

            if i < reps - 1 {
                await sleepMs(interKeyGapMs)
            }
        }
    }

    /// Press each key name down, wait `durationMs`, then release them in
    /// reverse order. Names are resolved the same way as a `key` token (table
    /// or layout reverse-map). The pressed keys are tracked in `HeldState` so
    /// an interrupted hold is cleaned up by `releaseAllHeld`.
    ///
    /// This is used for things like "hold shift, …, release shift": the caller
    /// typically issues arrow keys (separate `key` calls) between the down and
    /// up of the held modifier in the daemon, but the contract's `hold_key` is
    /// the atomic down-sleep-up primitive and we honor it as such.
    public static func holdKey(_ keyNames: [String], durationMs: Int) async throws {
        let target = try resolveKeyboardTarget()
        try await holdKey(
            keyNames,
            durationMs: durationMs,
            target: target
        )
    }

    static func holdKey(
        _ keyNames: [String],
        durationMs: Int,
        target requestedTarget: ProvenProcessTarget
    ) async throws {
        let target = try validateAuthorizedTarget(requestedTarget)
        recordResolvedTarget(target)
        try ensurePostable(target.pid)
        let src = try eventSource()

        // Resolve every name first so a bad name fails before we press anything.
        let codes: [CGKeyCode] = try keyNames.map { try KeySym.keycode(forToken: $0) }

        for code in codes {
            guard let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true) else {
                throw CUError("event_alloc", "Failed to allocate key-down event")
            }
            down.postToPid(target.pid)
            HeldState.keys.append(HeldKeyRecord(code: code, target: target))
            await sleepMs(interKeyGapMs)
        }

        await sleepMs(UInt64(max(0, durationMs)))

        // The duration is an actor reentrancy boundary. Prove that the exact
        // process lifetime is still present before posting any key-up event.
        let releaseTarget = try validateAuthorizedTarget(target)
        recordResolvedTarget(releaseTarget)
        try ensurePostable(releaseTarget.pid)

        for code in codes.reversed() {
            guard let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false) else {
                throw CUError("event_alloc", "Failed to allocate key-up event")
            }
            up.postToPid(releaseTarget.pid)
            HeldState.keys.complete(
                HeldKeyRecord(code: code, target: target)
            )
            await sleepMs(interKeyGapMs)
        }
    }

    // MARK: Type

    /// Type arbitrary Unicode text into the frontmost application,
    /// layout-independently. Each grapheme cluster is posted as a keyDown +
    /// keyUp pair carrying the literal UTF-16 via
    /// `keyboardSetUnicodeString`, with `virtualKey: 0`. Because the unicode
    /// payload overrides keycode translation, this works for emoji, CJK, and
    /// accented characters regardless of the active keyboard layout.
    ///
    /// Note: macOS Secure Input (enabled by password fields and some apps)
    /// silently drops synthetic keystrokes. We cannot reliably detect it, so
    /// typing into such a field is best-effort and simply has no effect — this
    /// is a documented platform limitation, not an error we can raise.
    public static func type(_ text: String) async throws {
        guard !text.isEmpty else { return }
        let target = try resolveKeyboardTarget()
        try await type(text, target: target)
    }

    static func type(
        _ text: String,
        target requestedTarget: ProvenProcessTarget
    ) async throws {
        guard !text.isEmpty else { return }
        let target = try validateAuthorizedTarget(requestedTarget)
        recordResolvedTarget(target)
        try ensurePostable(target.pid)
        let src = try eventSource()

        // Iterate grapheme clusters so multi-scalar emoji (e.g. flags, skin
        // tones, ZWJ sequences) are emitted as a single event with their full
        // UTF-16 representation rather than split across scalars.
        for grapheme in text {
            var utf16 = Array(String(grapheme).utf16)

            guard let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true) else {
                throw CUError("event_alloc", "Failed to allocate type key-down event")
            }
            down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
            down.postToPid(target.pid)

            guard let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) else {
                throw CUError("event_alloc", "Failed to allocate type key-up event")
            }
            up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
            up.postToPid(target.pid)

            await sleepMs(interGraphemeGapMs)
        }
    }

    // MARK: Teardown

    /// Release any keys/buttons we synthesized as "down" but never released
    /// (interrupted hold_key, a mouse_down with no matching mouse_up, etc.).
    /// Best-effort: swallows errors so teardown never throws. The daemon calls
    /// this on client disconnect / shutdown and the CLI never needs it (a
    /// one-shot process holds nothing across its single command).
    public static func releaseAllHeld() async {
        // The body has no awaits — defer to the synchronous core so teardown /
        // shutdown / signal paths can release held inputs BEFORE the process
        // exits (an async Task scheduled right before exit() may never run).
        releaseAllHeldSync()
    }

    /// Synchronous release of all held keys/buttons. Pure CGEvent posting (no
    /// awaits), safe to call from a non-async teardown that exits immediately
    /// afterward so a crashed/aborted agent loop never strands a held modifier
    /// or mouse button in the target app.
    public static func releaseAllHeldSync() {
        // Release held mouse buttons at their press location & original pid.
        let buttons = HeldState.buttons.records
        for held in buttons.reversed() {
            let pid = HeldInputReleasePolicy.pid(
                for: held.target,
                currentIdentity: AXTree.currentProcessIdentity(
                    pid: held.target.pid
                )
            )
            let event: CGEvent?
            if let src = source, pid != nil {
                event = CGEvent(
                    mouseEventSource: src,
                    mouseType: held.button.up,
                    mouseCursorPosition: held.point,
                    mouseButton: held.button.cg
                )
            } else {
                event = nil
            }
            switch HeldInputReleasePolicy.teardownPlan(
                identityMatches: pid != nil,
                sourceAvailable: source != nil,
                eventAllocated: event != nil
            ) {
            case .discardInvalidTarget:
                // A recycled/dead process can never be a safe retry target.
                HeldState.buttons.complete(held)
            case .retainForRetry:
                continue
            case .postAndComplete:
                guard let pid, let event else { continue }
                event.setIntegerValueField(.mouseEventClickState, value: 1)
                event.postToPid(pid)
                HeldState.buttons.complete(held)
            }
        }

        // Release held keys only to their original, still-matching process
        // lifetime. Never whichever app happens to be frontmost at teardown.
        let keys = HeldState.keys.records
        for held in keys.reversed() {
            let pid = HeldInputReleasePolicy.pid(
                for: held.target,
                currentIdentity: AXTree.currentProcessIdentity(
                    pid: held.target.pid
                )
            )
            let event: CGEvent?
            if let src = source, pid != nil {
                event = CGEvent(
                    keyboardEventSource: src,
                    virtualKey: held.code,
                    keyDown: false
                )
                event?.flags = []
            } else {
                event = nil
            }
            switch HeldInputReleasePolicy.teardownPlan(
                identityMatches: pid != nil,
                sourceAvailable: source != nil,
                eventAllocated: event != nil
            ) {
            case .discardInvalidTarget:
                HeldState.keys.complete(held)
            case .retainForRetry:
                continue
            case .postAndComplete:
                guard let pid, let event else { continue }
                event.postToPid(pid)
                HeldState.keys.complete(held)
            }
        }
    }
}

// MARK: - Int32 clamping helper

/// Clamp a (possibly out-of-range) Int delta into Int32 territory before
/// handing it to the CGEvent scroll ABI, so a pathological payload can't trap.
private func clampingToInt32(_ value: Int) -> Int {
    if value > Int(Int32.max) { return Int(Int32.max) }
    if value < Int(Int32.min) { return Int(Int32.min) }
    return value
}

// MARK: - KeySym

/// Key-name → keycode resolution and modifier parsing for the xdotool-style
/// sequences the contract uses (`"cmd+shift+a"`, `"Return"`, `"Page_Up"`, …).
///
/// Resolution order for a single key token:
///   1. The static `table` (named keys: Return, Tab, arrows, F-keys, keypad…),
///      checked case-insensitively against a rich alias set so both the
///      X11/xdotool spelling (`Return`, `Prior`, `BackSpace`) and the
///      mac_helper spelling (`enter`, `pageup`, `backspace`) resolve.
///   2. `keycodeForCharacter` — a reverse `UCKeyTranslate` over the CURRENT
///      keyboard layout for single printable characters (`a`, `;`, `=`, `é`…),
///      so layout-specific keys still map to the right physical key.
enum KeySym {

    /// Named, non-printable / special keys → virtual keycode. Keys are stored
    /// lowercased; lookups lowercase the token first. Includes both xdotool and
    /// mac_helper spellings so either vocabulary resolves.
    static let table: [String: CGKeyCode] = {
        var t: [String: CGKeyCode] = [:]
        func put(_ code: Int, _ names: String...) {
            for n in names { t[n.lowercased()] = CGKeyCode(code) }
        }

        // Editing / whitespace
        put(kVK_Return, "return", "enter", "\n", "\r")
        put(kVK_Tab, "tab", "\t")
        put(kVK_Space, "space", " ")
        put(kVK_Escape, "escape", "esc")
        put(kVK_Delete, "backspace", "delete", "back_space")        // kVK_Delete == Backspace
        put(kVK_ForwardDelete, "forwarddelete", "forward_delete", "del")

        // Navigation
        put(kVK_UpArrow, "up", "uparrow", "up_arrow")
        put(kVK_DownArrow, "down", "downarrow", "down_arrow")
        put(kVK_LeftArrow, "left", "leftarrow", "left_arrow")
        put(kVK_RightArrow, "right", "rightarrow", "right_arrow")
        put(kVK_Home, "home")
        put(kVK_End, "end")
        put(kVK_PageUp, "prior", "page_up", "pageup")
        put(kVK_PageDown, "next", "page_down", "pagedown")

        // Locks / misc
        put(kVK_CapsLock, "capslock", "caps_lock")
        put(kVK_Help, "help", "insert")

        // Keypad
        put(kVK_ANSI_Keypad0, "kp_0", "kp0")
        put(kVK_ANSI_Keypad1, "kp_1", "kp1")
        put(kVK_ANSI_Keypad2, "kp_2", "kp2")
        put(kVK_ANSI_Keypad3, "kp_3", "kp3")
        put(kVK_ANSI_Keypad4, "kp_4", "kp4")
        put(kVK_ANSI_Keypad5, "kp_5", "kp5")
        put(kVK_ANSI_Keypad6, "kp_6", "kp6")
        put(kVK_ANSI_Keypad7, "kp_7", "kp7")
        put(kVK_ANSI_Keypad8, "kp_8", "kp8")
        put(kVK_ANSI_Keypad9, "kp_9", "kp9")
        put(kVK_ANSI_KeypadDecimal, "kp_decimal", "kp_separator")
        put(kVK_ANSI_KeypadPlus, "kp_add", "kp_plus")
        put(kVK_ANSI_KeypadMinus, "kp_subtract", "kp_minus")
        put(kVK_ANSI_KeypadMultiply, "kp_multiply")
        put(kVK_ANSI_KeypadDivide, "kp_divide")
        put(kVK_ANSI_KeypadEquals, "kp_equal")
        put(kVK_ANSI_KeypadEnter, "kp_enter")
        put(kVK_ANSI_KeypadClear, "kp_clear", "clear", "num_lock")

        // Function keys
        put(kVK_F1, "f1");  put(kVK_F2, "f2");  put(kVK_F3, "f3");  put(kVK_F4, "f4")
        put(kVK_F5, "f5");  put(kVK_F6, "f6");  put(kVK_F7, "f7");  put(kVK_F8, "f8")
        put(kVK_F9, "f9");  put(kVK_F10, "f10"); put(kVK_F11, "f11"); put(kVK_F12, "f12")
        put(kVK_F13, "f13"); put(kVK_F14, "f14"); put(kVK_F15, "f15"); put(kVK_F16, "f16")
        put(kVK_F17, "f17"); put(kVK_F18, "f18"); put(kVK_F19, "f19"); put(kVK_F20, "f20")

        return t
    }()

    /// The set of tokens that name a modifier (not a key). Matches the
    /// mac_helper KEY_MAP aliases. Used both to build `CGEventFlags` and to
    /// know which token is the "real" key in a sequence.
    private static let modifierFlag: [String: CGEventFlags] = [
        "cmd": .maskCommand, "command": .maskCommand, "meta": .maskCommand, "super": .maskCommand, "win": .maskCommand,
        "ctrl": .maskControl, "control": .maskControl,
        "shift": .maskShift,
        "alt": .maskAlternate, "option": .maskAlternate, "opt": .maskAlternate,
        "fn": .maskSecondaryFn,
    ]

    /// Build the `CGEventFlags` for a list of modifier names (used by click
    /// modifiers). Unknown names are ignored (best-effort, matching the
    /// permissive TS contract where modifiers are advisory).
    static func flags(for modifiers: [String]) -> CGEventFlags {
        var flags: CGEventFlags = []
        for m in modifiers {
            if let f = modifierFlag[m.trimmingCharacters(in: .whitespaces).lowercased()] {
                flags.insert(f)
            }
        }
        return flags
    }

    /// Resolve a single non-modifier key token to a keycode (table first, then
    /// layout reverse-map for single characters). Throws `unknown_key`.
    static func keycode(forToken token: String) throws -> CGKeyCode {
        let trimmed = token.trimmingCharacters(in: .whitespaces)
        let lower = trimmed.lowercased()

        if let code = table[lower] {
            return code
        }
        // Single printable character → reverse-map on the current layout.
        if trimmed.count == 1, let ch = trimmed.first, let code = keycodeForCharacter(ch) {
            return code
        }
        // Lowercased single char (covers "A" when layout only maps "a").
        if lower.count == 1, let ch = lower.first, let code = keycodeForCharacter(ch) {
            return code
        }
        throw CUError("unknown_key", "Unsupported key: \(token)")
    }

    /// Parse a full xdotool-style sequence into `(modifierFlags, keyCode)`.
    /// All tokens but the last are treated as modifiers; the last is the key.
    /// A trailing `+` (or any empty token) is ignored.
    static func parse(_ seq: String) throws -> (CGEventFlags, CGKeyCode) {
        let rawTokens = seq.split(separator: "+", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }

        guard let keyToken = rawTokens.last else {
            throw CUError("unknown_key", "Empty key sequence")
        }

        var flags: CGEventFlags = []
        for token in rawTokens.dropLast() {
            if let f = modifierFlag[token.lowercased()] {
                flags.insert(f)
            } else {
                // A non-modifier appearing before the final token is malformed
                // (e.g. "a+b"). Surface it rather than silently dropping.
                throw CUError("unknown_key", "Unexpected modifier token: \(token)")
            }
        }

        let keyCode = try keycode(forToken: keyToken)
        return (flags, keyCode)
    }

    /// Reverse-map a single character to the physical keycode that produces it
    /// on the CURRENT keyboard layout. Walks every virtual keycode under the
    /// plausible modifier combinations (none / shift / option / shift+option)
    /// and translates via `UCKeyTranslate`, returning the first keycode whose
    /// output equals `ch`. Returns nil for characters not reachable on the
    /// active layout (the caller then throws `unknown_key`).
    static func keycodeForCharacter(_ ch: Character) -> CGKeyCode? {
        guard let inputSource = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
              let layoutPtr = TISGetInputSourceProperty(inputSource, kTISPropertyUnicodeKeyLayoutData)
        else {
            return nil
        }
        let layoutData = unsafeBitCast(layoutPtr, to: CFData.self)
        guard let bytes = CFDataGetBytePtr(layoutData) else { return nil }
        let kbType = UInt32(LMGetKbdType())

        let target = String(ch)
        // Modifier states are passed to UCKeyTranslate in its packed form
        // (Carbon modifier bits shifted right by 8).
        let modifierStates: [UInt32] = [
            0,
            UInt32(shiftKey >> 8),
            UInt32(optionKey >> 8),
            UInt32((shiftKey | optionKey) >> 8),
        ]

        // Rebind the raw UInt8 layout bytes to the UCKeyboardLayout struct the
        // Carbon API expects, scoped to the lookup, instead of an unchecked
        // `unsafeBitCast` (which the compiler flags as potential UB).
        return bytes.withMemoryRebound(to: UCKeyboardLayout.self, capacity: 1) { keyLayout in
            for vk in 0..<UInt16(128) {
                for mod in modifierStates {
                    var deadKeyState: UInt32 = 0
                    var chars = [UniChar](repeating: 0, count: 4)
                    var length = 0
                    let status = UCKeyTranslate(
                        keyLayout,
                        vk,
                        UInt16(kUCKeyActionDown),
                        mod,
                        kbType,
                        OptionBits(kUCKeyTranslateNoDeadKeysBit),
                        &deadKeyState,
                        chars.count,
                        &length,
                        &chars
                    )
                    if status == noErr, length > 0 {
                        let produced = String(utf16CodeUnits: chars, count: length)
                        if produced == target {
                            return CGKeyCode(vk)
                        }
                    }
                }
            }
            return nil
        }
    }
}
