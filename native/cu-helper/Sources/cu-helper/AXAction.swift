//
//  AXAction.swift
//  cu-helper
//
//  AX-FIRST actuation gradient (Codex parity, blueprint §4). Every verb acts on a
//  specific element addressed by the stable `index` from the latest get_app_state
//  (or, for click/scroll/drag, a window-relative point), preferring real
//  Accessibility actions over synthesized input. Only when no usable AX action
//  exists does it fall back to a synthetic pointer/keyboard event — and every such
//  event is posted with `CGEvent.postToPid(pid)`, never `.cghidEventTap`, so the
//  user's real pointer is never hijacked. A keyboard event's `.hidSystemState`
//  source describes its input state; it does not change this PID-only routing.
//
//  Why a gradient, not a single AXPress (the v1 mistake):
//   • Finder sidebars / Activity Monitor / System Settings rows are "clicked" by
//     selecting them on their parent AXList (AXSelectedChildren), not pressing.
//   • A bare "first available action" can fire AXShowMenu or AXScrollToVisible AS
//     IF it were a click — so the press tier is hard-limited to {Press,Confirm,Open}.
//   • The visible label of a row is often a static-text descendant with no action;
//     the actionable element is an ancestor/descendant, so we scan down 3 levels.
//   • Some controls only yield to an AX hit-test at their center, or (windows) to
//     activation-only raise/main/focus. Synthetic pointer events are the last resort.
//
//  Element resolution is delegated to `AXTree` (single source of truth for the
//  (window locator, path) re-resolvable locator + per-pid snapshot):
//  `refetch(pid:index:)` resolves and semantically validates the CURRENT live
//  AXUIElement, while `record(pid:index:)` returns the typed snapshot metadata
//  (role / value / settable / frameGlobal / rawActions) the gradient branches on.
//
//  Threading: `@MainActor`. AX APIs are NOT thread-safe; all AX + injection traffic
//  stays on the main actor (a prior background-queue AX call crashed the daemon).
//

import ApplicationServices
import AppKit
import CoreGraphics
import Foundation

/// Pure UTF-16 text-range operations shared by AX selection and insertion.
/// Accessibility text ranges are measured in UTF-16 code units, so NSString is
/// the arithmetic authority even when the source contains emoji or combining
/// characters.
public enum TextEditing {
    public enum SelectionMode: String, Sendable {
        case text
        case cursorBefore = "cursor_before"
        case cursorAfter = "cursor_after"
    }

    public struct Edit: Equatable, Sendable {
        public let value: String
        public let caret: NSRange
    }

    public enum CommitOutcome: Equatable, Sendable {
        case valueRejected
        case complete
        case valueOnly
        case rolledBack
        case stateUnknown
    }

    public static func range(
        in value: String,
        text: String,
        prefix: String? = nil,
        suffix: String? = nil
    ) throws -> NSRange {
        guard !text.isEmpty else {
            throw CUError("text_not_found", "select_text requires non-empty text")
        }

        let source = value as NSString
        let prefixLength = prefix.map { ($0 as NSString).length } ?? 0
        let suffixLength = suffix.map { ($0 as NSString).length } ?? 0
        var matches: [NSRange] = []
        var search = NSRange(location: 0, length: source.length)

        while search.location <= source.length {
            let match = source.range(of: text, options: [], range: search)
            if match.location == NSNotFound { break }

            let prefixMatches: Bool
            if let prefix {
                prefixMatches = match.location >= prefixLength
                    && source.substring(
                        with: NSRange(
                            location: match.location - prefixLength,
                            length: prefixLength
                        )
                    ) == prefix
            } else {
                prefixMatches = true
            }

            let end = match.location + match.length
            let suffixMatches: Bool
            if let suffix {
                suffixMatches = end <= source.length - suffixLength
                    && source.substring(
                        with: NSRange(location: end, length: suffixLength)
                    ) == suffix
            } else {
                suffixMatches = true
            }

            if prefixMatches && suffixMatches { matches.append(match) }

            // Advance one UTF-16 code unit so overlapping occurrences are also
            // counted. Otherwise "aaa" / "aa" would look unique and selection
            // could silently target the wrong occurrence.
            let next = match.location + 1
            if next > source.length { break }
            search = NSRange(location: next, length: source.length - next)
        }

        guard !matches.isEmpty else {
            throw CUError("text_not_found", "The requested text was not found in the element")
        }
        guard matches.count == 1 else {
            throw CUError(
                "ambiguous_text",
                "The requested text occurs more than once; provide prefix and/or suffix to identify one occurrence"
            )
        }
        return matches[0]
    }

    public static func selectionRange(
        _ selected: NSRange,
        mode: SelectionMode
    ) -> NSRange {
        switch mode {
        case .text:
            return selected
        case .cursorBefore:
            return NSRange(location: selected.location, length: 0)
        case .cursorAfter:
            return NSRange(location: selected.location + selected.length, length: 0)
        }
    }

    public static func replacingSelection(
        in value: String,
        range: NSRange,
        with replacement: String
    ) throws -> Edit {
        let source = value as NSString
        guard range.location != NSNotFound,
              range.location >= 0,
              range.length >= 0,
              range.location <= source.length,
              range.length <= source.length - range.location
        else {
            throw CUError("invalid_selection", "The selected text range is outside the element value")
        }

        let updated = source.replacingCharacters(in: range, with: replacement)
        let caret = NSRange(
            location: range.location + (replacement as NSString).length,
            length: 0
        )
        return Edit(value: updated, caret: caret)
    }

    /// Apply the two-step AX edit exactly once. Once the value write succeeds,
    /// a later caret failure is no longer retry-safe: surfacing an error could
    /// make the caller insert the same text a second time. Callers can retain a
    /// successful receipt while distinguishing the rare value-only outcome.
    public static func commitOnce(
        _ edit: Edit,
        originalValue: String,
        originalSelection: NSRange,
        writeValue: (String) -> Bool,
        writeCaret: (NSRange) -> Bool
    ) -> CommitOutcome {
        guard writeValue(edit.value) else { return .valueRejected }
        guard !writeCaret(edit.caret) else { return .complete }

        // Best-effort transaction: restore both pieces of the original editing
        // state before letting the caller use an event fallback. If the value
        // cannot be restored, the new text remains committed and must be treated
        // as success to prevent duplicate retries. If only selection restoration
        // fails, neither retrying nor falling back is safe without a fresh read.
        guard writeValue(originalValue) else { return .valueOnly }
        return writeCaret(originalSelection) ? .rolledBack : .stateUnknown
    }
}

/// A change-count guarded lease for temporary pasteboard contents. It clones
/// every item/type payload before mutation and restores only while its own
/// temporary write is still the latest change, so a concurrent user copy wins.
@MainActor
public final class ClipboardLease {
    private struct ItemSnapshot {
        let entries: [(type: NSPasteboard.PasteboardType, data: Data)]
    }

    private let pasteboard: NSPasteboard
    private let originalItems: [ItemSnapshot]
    private let captureError: CUError?
    private var temporaryChangeCount: Int?

    public init(pasteboard: NSPasteboard = .general) {
        self.pasteboard = pasteboard

        var snapshots: [ItemSnapshot] = []
        var failure: CUError?
        for item in pasteboard.pasteboardItems ?? [] {
            var entries: [(NSPasteboard.PasteboardType, Data)] = []
            for type in item.types {
                guard let data = item.data(forType: type) else {
                    failure = CUError(
                        "clipboard_snapshot_failed",
                        "Could not capture pasteboard type \(type.rawValue)"
                    )
                    break
                }
                entries.append((type, data))
            }
            if failure != nil { break }
            snapshots.append(ItemSnapshot(entries: entries))
        }
        originalItems = snapshots
        captureError = failure
    }

    public func writeTemporaryString(_ text: String) throws {
        if let captureError { throw captureError }

        pasteboard.clearContents()
        temporaryChangeCount = pasteboard.changeCount
        guard pasteboard.setString(text, forType: .string) else {
            throw CUError("clipboard_write_failed", "Could not write temporary pasteboard text")
        }
        temporaryChangeCount = pasteboard.changeCount
    }

    func writeTemporaryStringWithReceipt(_ text: String) throws -> ClipboardPasteReceipt {
        try writeTemporaryContentWithReceipt(text, format: .text)
    }

    func writeTemporaryContentWithReceipt(
        _ text: String,
        format: ClipboardPasteFormat
    ) throws -> ClipboardPasteReceipt {
        if let captureError { throw captureError }
        let receipt = ClipboardPasteReceipt(text: text, format: format)
        let item = NSPasteboardItem()
        let types = Array(format.promisedData(for: text).keys)
        guard item.setDataProvider(receipt, forTypes: types) else {
            throw CUError("clipboard_write_failed", "Could not register temporary pasteboard data")
        }
        pasteboard.clearContents()
        temporaryChangeCount = pasteboard.changeCount
        guard pasteboard.writeObjects([item]) else {
            throw CUError("clipboard_write_failed", "Could not write temporary pasteboard data")
        }
        temporaryChangeCount = pasteboard.changeCount
        return receipt
    }

    /// Whether the temporary text is still the latest pasteboard write. Check
    /// this immediately before sending Command-V so a concurrent user copy is
    /// never pasted into the agent's target application.
    public func temporaryWriteIsCurrent() -> Bool {
        guard let temporaryChangeCount else { return false }
        return pasteboard.changeCount == temporaryChangeCount
    }

    @discardableResult
    public func restoreIfUnchanged() -> Bool {
        guard let temporaryChangeCount else { return false }
        self.temporaryChangeCount = nil
        guard pasteboard.changeCount == temporaryChangeCount else { return false }

        pasteboard.clearContents()
        guard !originalItems.isEmpty else { return true }

        let items = originalItems.map { snapshot -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for entry in snapshot.entries {
                item.setData(entry.data, forType: entry.type)
            }
            return item
        }
        return pasteboard.writeObjects(items)
    }
}

@MainActor
public enum AXAction {

    private struct MouseBurstSpec {
        let type: CGEventType
        let point: CGPoint
        let button: MouseButton
        /// Which click of a multi-click this event belongs to: 1, 2, 3… for the
        /// press/release pairs, and **0 for movement**.
        ///
        /// Zero is not a detail. A move or drag event is not part of a click,
        /// and AppKit says so by reporting `clickCount == 0` for it. We used to
        /// hand the leading move the same number as the clicks that followed
        /// (the repeat count, so 1 for a single click and 2 for a double). The
        /// reference implementation posts no move at all for a click, and gives
        /// its drag-movement events `clickCount = 0`.
        let clickState: Int
        /// Ties a press to the release that ends it: both halves of one click
        /// carry the same number, movement carries its own. See
        /// `WindowTargetedEvent.makeMouseEvent`.
        let eventNumber: Int
    }

    /// The `clickState` an event of `type` gets when it belongs to click number
    /// `index` of a gesture. Movement is never part of a click, so it reports 0
    /// no matter which click it precedes or connects.
    ///
    /// Extracted so the rule is stated once and can be tested: every burst
    /// builder used to spell it out per event, and the leading move of a click
    /// was spelled with the repeat count instead of zero.
    static func mouseClickState(for type: CGEventType, click index: Int) -> Int {
        isMovement(type) ? 0 : index
    }

    /// Movement events: pointer transport, no button transition.
    static func isMovement(_ type: CGEventType) -> Bool {
        switch type {
        case .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged:
            return true
        default:
            return false
        }
    }

    // MARK: - Tunables

    /// Synthetic event source — combined session state so events inherit the real
    /// modifier baseline WITHOUT going through the HID tap (which would move the
    /// user's physical pointer). Posted exclusively via `postToPid`.
    static let eventSource: CGEventSource? = HelperEventMarker.mark(
        CGEventSource(stateID: .combinedSessionState)
    )

    /// NOTE: the old `axSettle` constant (a blocking 0.15s after every action)
    /// is gone. It existed because the router used to re-capture state after
    /// each mutation — it no longer does, so the delay was charged to every
    /// action while nobody was looking, and it blocked the main actor, stalling
    /// the virtual cursor animation. The wait now happens once at capture time;
    /// see `UISettlePolicy`.

    /// Max UTF-16 units per `keyboardSetUnicodeString` chunk (blueprint §4 ≤64).
    private static let unicodeChunk = 64

    /// Lines scrolled per "page" for the synthetic-wheel fallback (blueprint §4).
    private static let linesPerPage = 12

    /// How far down to scan for an actionable descendant (blueprint §4: "向下3层").
    private static let descendantScanDepth = 3

    /// AX action names (string-literal; not all are exported as kAX… constants).
    private static let axPress = kAXPressAction as String
    private static let axConfirm = "AXConfirm"
    private static let axOpen = "AXOpen"
    private static let axShowMenu = kAXShowMenuAction as String
    private static let axRaise = kAXRaiseAction as String

    // MARK: - Click (index gradient)

    /// Click the element at `index` via the AX gradient (blueprint §4 ①–⑥),
    /// repeating the resolved action `clickCount` times. Right button maps to
    /// AXShowMenu. Returns a short tag naming the tier that handled it (for logs /
    /// diagnostics). Falls back to a synthetic `postToPid` pointer click at the
    /// element center only when no AX path applies.
    @discardableResult
    public static func click(
        pid: pid_t,
        index: Int,
        clickCount: Int = 1,
        button: MouseButton = .left
    ) async throws -> String {
        let element = try resolveElement(pid: pid, index: index)
        let record = AXTree.record(pid: pid, index: index)
        let reps = max(1, clickCount)

        // ── Right button: secondary menu, nothing else. ───────────────────────
        if button == .right {
            if perform(axShowMenu, on: element, times: reps) {
                return "ax:show_menu"
            }
            // Fall through to a synthetic right-click at the element center.
            if let p = centerGlobal(record) {
                try await clickPoint(pid: pid, x: p.x, y: p.y, clickCount: reps, button: .right)
                return "synthetic:point"
            }
            throw CUError("no_action", "Element \(index) exposes no right-click (AXShowMenu) and has no frame to click")
        }

        if button != .left {
            // Middle/back/forward have no AX analogue; go straight to a
            // synthetic point click using their exact CoreGraphics button id.
            if let p = centerGlobal(record) {
                try await clickPoint(pid: pid, x: p.x, y: p.y, clickCount: reps, button: button)
                return "synthetic:point"
            }
            throw CUError("no_action", "Element \(index) has no frame for a \(button.rawValue) click")
        }

        // ── ① Native list row → select on the parent AXList. ──────────────────
        // (Finder sidebar / Activity Monitor / System Settings rows are selected,
        // not pressed. Single click only — multi-click on a row means activate.)
        if reps == 1, selectContainingListItem(of: element) {
            settle()
            return "ax:list_select"
        }

        // ── ② Primary press on the element: {Press, Confirm, Open} only. ──────
        if let tag = pressPrimary(element, times: reps) {
            settle()
            return "ax:\(tag)"
        }

        // ── ③ Scan up to 3 levels of descendants for an actionable node. ──────
        if let descendant = firstActionableDescendant(of: element, depth: descendantScanDepth) {
            if button == .right {
                if perform(axShowMenu, on: descendant, times: reps) { settle(); return "ax:descendant:show_menu" }
            } else if let tag = pressPrimary(descendant, times: reps) {
                settle()
                return "ax:descendant:\(tag)"
            }
        }

        // ── ④ AX hit-test at the element center, then press what's there. ─────
        if let center = centerGlobal(record), let hit = hitTest(pid: pid, at: center) {
            // Avoid pressing the element we already failed on.
            if !sameElement(hit, element), let tag = pressPrimary(hit, times: reps) {
                settle()
                return "ax:hittest:\(tag)"
            }
        }

        // ── ⑤ Window-role activation-only (Raise / kAXMain / kAXFocused). ─────
        if isWindowRole(record), activateWindow(element) {
            settle()
            return "ax:activate"
        }

        // ── ⑥ Last resort: synthetic pointer click via postToPid. ─────────────
        if let center = centerGlobal(record) {
            try await clickPoint(pid: pid, x: center.x, y: center.y, clickCount: reps, button: button)
            return "synthetic:point"
        }

        throw CUError(
            "no_action",
            "Element \(index) exposes no Press/Confirm/Open action and has no frame; cannot click"
        )
    }

    /// Shared preparation for every synthetic action. The actor is yielded
    /// while focus is established, so lifecycle notifications are not delayed.
    @MainActor
    @discardableResult
    private static func ensureTargetAcceptsInput(
        pid: pid_t, window: WindowGeometry.Window? = nil,
        beforeFocus: (@MainActor (FocusEventMonitor.RegistrationReceipt) async throws -> Void)? = nil
    ) async throws -> FocusEventMonitor.RegistrationReceipt {
        try await SyntheticWindowFocus.prepareInput(pid: pid, window: window, beforeFocus: beforeFocus)
    }

    /// Synthetic pointer click at a GLOBAL (Quartz, top-left) point, posted to the
    /// owning process via `postToPid` (never the HID tap). `clickCount` repeats the
    /// down/up pair with the matching click-state so double/triple clicks register.

    public static func clickPoint(
        pid: pid_t,
        x: Double,
        y: Double,
        clickCount: Int = 1,
        button: MouseButton = .left
    ) async throws {
        let point = CGPoint(x: x, y: y)
        guard let src = eventSource else {
            throw CUError(CUError.Code.eventAlloc, "Failed to allocate a combined-session event source for a synthetic click")
        }

        // Resolve the target window ONCE, here, and refuse if it cannot be
        // named. Every event in the burst is bound to this same window, so the
        // burst can no longer half-succeed against a window that moved.
        let window = try requireBindableWindow(at: point, pid: pid)
        let target = try Injection.authorizeResolvedTarget(pid: pid)

        let focusReceipt = try await ensureTargetAcceptsInput(pid: pid, window: window, beforeFocus: { receipt in
            try await movePointerBeforeFocus(
                at: point, window: window,
                validate: {
                    _ = try Injection.validateAuthorizedTarget(target)
                    try SyntheticWindowFocus.validate(receipt)
                    guard WindowGeometry.window(id: window.id, pid: pid) == window else {
                        throw CUError("stale_window", "The pointer target window moved or closed. Read its current state before retrying.")
                    }
                },
                post: { WindowTargetedEvent.post($0, to: pid) }
            )
        })
        let events = try clickEvents(
            at: point, clickCount: clickCount, button: button,
            source: src, pid: pid, window: window
        )
        try await postMouseBurst(
            events, target: target, window: window, button: button,
            focusReceipt: focusReceipt, pause: nil
        )
    }

    static func clickEvents(
        at point: CGPoint, clickCount: Int, button: MouseButton,
        source: CGEventSource, pid: pid_t, window: WindowGeometry.Window
    ) throws -> [CGEvent] {
        let reps = max(1, clickCount)
        // Ordinary clicks are only down/up pairs. Pointer movement is a
        // separate action; inserting it here changes the reference protocol.
        // Allocate every pair before the first post so failure cannot strand a down.
        var specs: [MouseBurstSpec] = []
        for i in 1...reps {
            // One number per press/release pair: that pairing is what makes the
            // two events read as a single click rather than two loose halves.
            let clickNumber = WindowTargetedEvent.nextEventNumber()
            specs.append(MouseBurstSpec(
                type: button.down,
                point: point,
                button: button,
                clickState: mouseClickState(for: button.down, click: i),
                eventNumber: clickNumber
            ))
            specs.append(MouseBurstSpec(
                type: button.up,
                point: point,
                button: button,
                clickState: mouseClickState(for: button.up, click: i),
                eventNumber: clickNumber
            ))
        }
        return try EventBurst.allocateAll(
            specs: specs
        ) { spec in
            makeMouse(spec, source: source, targetPid: pid, window: window)
        }
    }

    /// The reference controller sends this hover before preparing app focus;
    /// moving the visual cursor alone does not notify the target application.
    static func movePointerBeforeFocus(
        at point: CGPoint, window: WindowGeometry.Window,
        validate: @MainActor () throws -> Void, post: @MainActor (CGEvent) -> Void,
        pause: @MainActor (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        makeEvent: @MainActor (CGPoint, WindowGeometry.Window) -> CGEvent? = pointerMoveEvent
    ) async throws {
        try Task.checkCancellation()
        try validate()
        guard let event = makeEvent(point, window) else {
            throw CUError(CUError.Code.eventAlloc, "Failed to allocate a window-targeted pointer move")
        }
        try Task.checkCancellation()
        try validate()
        try Task.checkCancellation()
        post(event)
        try await pause(.milliseconds(10))
        try Task.checkCancellation()
        try validate()
    }

    static func pointerMoveEvent(at point: CGPoint, window: WindowGeometry.Window) -> CGEvent? {
        // This standalone hover has clickCount 1 in the reference protocol;
        // the separate drag-movement rule remains unchanged.
        WindowTargetedEvent.makeMouseEvent(
            type: .mouseMoved, nsType: .mouseMoved, point: point, button: .left,
            clickCount: 1, windowID: window.id, windowBounds: window.bounds,
            eventNumber: WindowTargetedEvent.nextEventNumber()
        )
    }

    /// The window a coordinate action will name, or a refusal explaining why no
    /// window can be named.
    ///
    /// This exists because the alternative — posting an unbound event — is not a
    /// degraded success, it is a silent failure. Chromium and other custom
    /// renderers route input by the window an event claims and drop events that
    /// claim none, so an unbound click is delivered, acknowledged, and ignored:
    /// the caller gets "Action completed" for an action that could never have
    /// happened. A minimized target reproduced exactly that, for every click and
    /// every keystroke of a whole session.
    ///
    /// Codex refuses the same case rather than guessing — its service carries a
    /// dedicated `cannotClickOffscreenElement` error.
    private static func requireBindableWindow(
        at point: CGPoint,
        pid: pid_t
    ) throws -> WindowGeometry.Window {
        switch WindowGeometry.binding(at: point, pid: pid) {
        case .success(let window):
            return window
        case .failure(.noWindowOnScreen):
            throw CUError(
                "target_window_offscreen",
                """
                The target app has no window on screen, so no click or keystroke \
                can reach it. It is minimized, hidden, or on another Space. \
                Call get_app_state so Computer Use can restore the explicitly \
                selected app before retrying the action.
                """
            )
        case .failure(.pointOutsideWindows):
            throw CUError(
                "point_outside_target_window",
                """
                The coordinate does not fall inside any window of the target \
                app, so the action was not sent. Call get_app_state and re-read \
                the coordinate off the fresh screenshot; the window has probably \
                moved or resized.
                """
            )
        }
    }

    /// Coordinate click that PREFERS the AX path (Codex parity). The model gives a
    /// point in the get_app_state screenshot; we map it to a GLOBAL point (caller's
    /// job) and hit-test the AX element under it, then press what's there. This is
    /// the load-bearing fix for Chromium/CEF apps (e.g. NeteaseMusic): the tree
    /// traversal can't see their web content (get_app_state is a bare shell), but
    /// `AXUIElementCopyElementAtPosition` makes Chromium instantiate the a11y node
    /// for THAT point on demand — so we get a real, pressable element and call
    /// `AXPress`, with NO synthetic mouse event, without stealing the pointer, and
    /// while the app stays in the background. This is exactly what Codex does
    /// (its service imports `AXUIElementCopyElementAtPosition` + `…PerformAction`
    /// and posts ZERO `CGEvent`s). Falls back to the synthetic `postToPid` click
    /// (`clickPoint`) when no AX element answers or the press finds no action.
    /// Returns a tag naming the path taken, for diagnostics. Left button only takes
    /// the AX path; other buttons have no clean per-point AX analogue and go
    /// straight to a synthetic event.
    @discardableResult
    public static func clickAtPoint(
        pid: pid_t,
        x: Double,
        y: Double,
        clickCount: Int = 1,
        button: MouseButton = .left
    ) async throws -> String {
        let point = CGPoint(x: x, y: y)
        let reps = max(1, clickCount)

        if button == .left {
            nudgeChromiumAccessibility(pid: pid)
            if let hit = hitTest(pid: pid, at: point) {
                if let tag = pressPrimary(hit, times: reps) {
                    settle()
                    return "ax:point:\(tag)"
                }
                if let descendant = firstActionableDescendant(of: hit, depth: descendantScanDepth),
                   let tag = pressPrimary(descendant, times: reps) {
                    settle()
                    return "ax:point:descendant:\(tag)"
                }
            }
        }

        // No AX element answered (or a non-left button): synthetic pointer click.
        try await clickPoint(pid: pid, x: x, y: y, clickCount: reps, button: button)
        return "synthetic:point"
    }

    /// Best-effort nudge so a Chromium/Electron/CEF app exposes its accessibility
    /// tree for the upcoming hit-test. `AXManualAccessibility` is the Chromium
    /// switch (Codex's `enableElectronAccessibility`); harmless on apps that ignore
    /// it. `AXUIElementCopyElementAtPosition` is itself enough to trigger on-demand
    /// instantiation, but setting this first is cheap insurance. We deliberately do
    /// NOT set `AXEnhancedUserInterface` here — that one mutates native AppKit AX
    /// structure and is unnecessary for a point hit-test.
    private static func nudgeChromiumAccessibility(pid: pid_t) {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 1.0)
        AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    }

    // MARK: - Set value

    /// Write `value` into the element at `index` via AX, gated on
    /// `AXUIElementIsAttributeSettable(kAXValue)`. Does NOT force focus (the v1 bug)
    /// — settable controls accept a value without it, and forcing focus on a
    /// non-settable one is both useless and a side effect. Returns the (before,
    /// after) string values so the caller can confirm the write took.
    @discardableResult
    public static func setValue(pid: pid_t, index: Int, value: String) throws -> (before: String?, after: String?) {
        let element = try resolveElement(pid: pid, index: index)

        guard isSettable(element, kAXValueAttribute) else {
            throw CUError("not_settable", "Cannot set a value for an element that is not settable")
        }

        let before = stringAttribute(element, kAXValueAttribute)
        let err = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString)
        guard err == .success else {
            throw CUError("ax_failed", "set_value failed (AXError \(err.rawValue)) on element \(index)")
        }
        settle()
        let after = stringAttribute(element, kAXValueAttribute)
        return (before, after)
    }

    // MARK: - Select text

    /// Select one uniquely-resolved text occurrence, or collapse the selection
    /// immediately before/after it. `resolveElement` performs the authoritative
    /// AXTree refetch; the only focus mutation is the target element's in-app
    /// AXFocused flag, and only when selection cannot target an unfocused node.
    @discardableResult
    public static func selectText(
        pid: pid_t,
        index: Int,
        text: String,
        prefix: String?,
        suffix: String?,
        mode: TextEditing.SelectionMode
    ) throws -> NSRange {
        let element = try resolveElement(pid: pid, index: index)
        guard isSettable(element, kAXSelectedTextRangeAttribute) else {
            throw CUError("not_selectable", "Element \(index) does not support text selection")
        }
        guard let value = textValueAttribute(element) else {
            throw CUError("not_selectable", "Element \(index) has no string value to select")
        }

        let match = try TextEditing.range(
            in: value,
            text: text,
            prefix: prefix,
            suffix: suffix
        )
        let selection = TextEditing.selectionRange(match, mode: mode)

        do {
            try setSelectedTextRange(element, selection)
        } catch {
            // Some apps require the element to hold in-app focus before they
            // accept AXSelectedTextRange. This never activates the application.
            guard !sameElement(focusedElement(of: pid), element),
                  setBool(element, kAXFocusedAttribute)
            else { throw error }
            try setSelectedTextRange(element, selection)
        }
        settle()
        return selection
    }

    // MARK: - Secondary action (pretty ↔ raw)

    /// Perform a secondary action on the element at `index`. The model sees PRETTY
    /// names (`Raise`, `Scroll Up`, `Show Menu`) — the same transform the renderer
    /// applies (strip `AX`, drop `ByPage`, split camelCase). We accept either the
    /// pretty name or the raw `AX…` token and translate back to the element's real
    /// action before calling `AXUIElementPerformAction`. Unknown/unsupported →
    /// `"<action> is not a valid secondary action for <index>"`.
    public static func performSecondary(pid: pid_t, index: Int, action: String) throws {
        let element = try resolveElement(pid: pid, index: index)
        let raws = actionNames(element)

        guard let raw = matchAction(requested: action, available: raws) else {
            throw CUError("invalid_action", "\(action) is not a valid secondary action for \(index)")
        }

        let err = AXUIElementPerformAction(element, raw as CFString)
        guard err == .success else {
            throw CUError("ax_failed", "perform_secondary_action(\(raw)) failed (AXError \(err.rawValue)) on element \(index)")
        }
        settle()
    }

    // MARK: - Scroll

    /// Scroll the element at `index` (preferred) — or, if `index` is nil, the
    /// element under the given GLOBAL point — `pages` pages in `direction`
    /// (up/down/left/right). Element-domain first: repeat `AXScroll{Up,Down,Left,
    /// Right}ByPage` floor(pages) times if the element exposes it; else synthesize a
    /// wheel event at the element center (12 lines/page) via `postToPid`.
    public static func scroll(
        pid: pid_t,
        index: Int?,
        x: Double? = nil,
        y: Double? = nil,
        direction: String,
        pages: Double = 1
    ) async throws {
        let dir = direction.lowercased()
        guard ["up", "down", "left", "right"].contains(dir) else {
            throw CUError("bad_payload", "Invalid scroll direction: \(direction)")
        }
        guard pages.isFinite, pages > 0 else {
            throw CUError("bad_payload", "scroll 'pages' must be a positive number")
        }

        // Resolve the target element (by index) and its center, or a bare point.
        var element: AXUIElement?
        var center: CGPoint?
        if let index {
            element = try resolveElement(pid: pid, index: index)
            center = centerGlobal(AXTree.record(pid: pid, index: index))
        }
        if center == nil, let x, let y {
            center = CGPoint(x: x, y: y)
        }

        // ── Element domain: AXScroll…ByPage, floor(pages) repeats. ────────────
        let wholePages = Int(pages.rounded(.down))
        if wholePages >= 1, let element {
            let pageAction = "AXScroll\(dir.capitalized)ByPage" // AXScrollUpByPage, …
            if actionNames(element).contains(pageAction) {
                for _ in 0..<wholePages {
                    _ = AXUIElementPerformAction(element, pageAction as CFString)
                    try await Task.sleep(for: .milliseconds(50))
                }
                settle()
                return
            }
        }

        // ── Synthetic wheel at the element center (or point). ─────────────────
        guard let point = center else {
            throw CUError("no_target", "scroll: element \(index.map(String.init) ?? "?") has no frame and no x/y point was given")
        }
        let window = try requireBindableWindow(at: point, pid: pid)
        let target = try Injection.authorizeResolvedTarget(pid: pid)
        let focusReceipt = try await ensureTargetAcceptsInput(pid: pid, window: window)
        _ = try Injection.validateAuthorizedTarget(target)
        try SyntheticWindowFocus.validate(focusReceipt)
        guard WindowGeometry.window(id: window.id, pid: pid) == window else {
            throw CUError("stale_window", "The scroll target moved or closed. Read its current state before retrying.")
        }
        try scrollWheel(at: point, direction: dir, pages: pages, pid: pid)
        settle()
    }

    // MARK: - Type text

    /// Type `text` into the focused element. Preferred path replaces its current
    /// UTF-16 kAXSelectedTextRange (or inserts at the UTF-16 end when unavailable),
    /// then places the caret immediately after the inserted text. If AX editing is
    /// unavailable, a PID-directed Unicode event path precedes clipboard paste.
    public static func typeText(pid: pid_t, _ text: String) async throws {
        guard !text.isEmpty else { return }
        let target = try Injection.authorizeResolvedTarget(pid: pid)
        let window = try keyboardWindow(pid: pid)

        // Validate the lifetime without resetting a still-focused field. An
        // observed loss requires preparation again before keyboard input.
        let focusReceipt = try await ensureTargetAcceptsInput(pid: pid, window: window)
        _ = try Injection.validateAuthorizedTarget(target)
        try SyntheticWindowFocus.validate(focusReceipt)
        try validateKeyboardWindow(window, pid: pid)

        let focused = focusedElement(of: pid)

        // ── Preferred: replace the live selection and restore the caret. ─────
        if let focused,
           isTextEntry(focused),
           isSettable(focused, kAXValueAttribute),
           isSettable(focused, kAXSelectedTextRangeAttribute),
           let original = textValueAttribute(focused) {
            let selected = selectedTextRange(focused)
                ?? NSRange(location: (original as NSString).length, length: 0)
            let edit = try TextEditing.replacingSelection(
                in: original,
                range: selected,
                with: text
            )
            let outcome = TextEditing.commitOnce(
                edit,
                originalValue: original,
                originalSelection: selected,
                writeValue: { value in
                    AXUIElementSetAttributeValue(
                        focused,
                        kAXValueAttribute as CFString,
                        value as CFString
                    ) == .success
                },
                writeCaret: { range in
                    do {
                        try setSelectedTextRange(focused, range)
                        return true
                    } catch {
                        return selectedTextRange(focused) == range
                    }
                }
            )
            switch outcome {
            case .complete, .valueOnly:
                // A successful value write is a successful mutation even if a
                // transient AX caret update failed. Never turn it into a
                // retryable error that could duplicate the insertion.
                settle()
                return
            case .valueRejected, .rolledBack:
                break
            case .stateUnknown:
                throw CUError(
                    "text_edit_state_unknown",
                    "The text edit was rolled back but its selection could not be restored. Do not retry type_text; call get_app_state and select_text again."
                )
            }
            // A failed value write leaves the old value intact; continue down
            // the injection gradient.
        }

        // ── Fallback 1: Unicode keyboard, only into an actual text field/area
        //    (reliable for native AppKit fields). ───────────────────────────────
        if let focused, isTextEntry(focused) {
            try SyntheticWindowFocus.validate(focusReceipt)
            do {
                try postUnicodeText(pid: pid, text: text)
                return
            } catch {
                // Allocation is completed before any event is posted, so a
                // failure here is safe to continue to clipboard paste.
            }
        }

        // ── Fallback 2 (last resort): clipboard paste — Codex parity. CEF/Chromium
        //    fields (e.g. NeteaseMusic's search box) expose NO settable AX element
        //    and no AX-focused text entry, but they DO hold in-app keyboard focus
        //    once the model clicks them. ⌘V reaches that in-app-focused element via
        //    postToPid without the app being frontmost. Save + restore the user's
        //    clipboard so we don't clobber it. (This replaces the old hard
        //    `no_focus` throw that stranded every CEF text-input task.)
        try await typeViaClipboard(target: target, text)
    }

    /// Explicit Codex-compatible paste path. Unlike `typeText`, this does not
    /// first try AX value mutation or Unicode key events; it targets the app's
    /// in-process focused field with Command-V and restores the user's original
    /// pasteboard after observing a real promised-data read.
    static func pasteText(
        pid: pid_t,
        _ text: String,
        format: ClipboardPasteFormat
    ) async throws {
        guard !text.isEmpty else { return }
        let target = try Injection.authorizeResolvedTarget(pid: pid)
        try await typeViaClipboard(target: target, text, format: format)
    }

    /// Paste `text` into whatever holds in-app keyboard focus in `pid`, via the
    /// system clipboard + ⌘V (Codex's approach for CEF/Chromium text fields).
    /// The read receipt confirms supplied clipboard bytes, not the reader's
    /// PID or the field's final value; the next screenshot still verifies UI.
    private static func typeViaClipboard(
        target: ProvenProcessTarget,
        _ text: String,
        format: ClipboardPasteFormat = .text
    ) async throws {
        let pid = target.pid
        try await ClipboardPasteReceipt.perform(
            text: text,
            format: format,
            lease: ClipboardLease()
        ) { validate in
            try await pressKey(pid: pid, "super+v", validateBeforePosting: {
                _ = try Injection.validateAuthorizedTarget(target)
                try validate()
            })
        }
    }

    // MARK: - Press key

    /// Deliver modifier transitions as flagsChanged events, including for a
    /// bare Return after a shortcut. Restore the captured session baseline
    /// without posting anything to the HID tap.
    public static func pressKey(
        pid: pid_t, _ key: String,
        validateBeforePosting: () throws -> Void = {}
    ) async throws {
        let chords = try KeyMapping.parse(key)
        guard !chords.isEmpty else {
            throw CUError(CUError.Code.unknownKey, "Empty key sequence")
        }
        let target = try Injection.authorizeResolvedTarget(pid: pid)
        let window = try keyboardWindow(pid: pid)
        var focusReceipt: FocusEventMonitor.RegistrationReceipt?
        try await KeyboardEventBurst.dispatch(
            chords: chords,
            prepare: { focusReceipt = try await ensureTargetAcceptsInput(pid: pid, window: window) },
            validateBeforePosting: {
                _ = try Injection.validateAuthorizedTarget(target)
                try SyntheticWindowFocus.validate(focusReceipt)
                try validateKeyboardWindow(window, pid: pid)
                try validateBeforePosting()
            },
            post: { WindowTargetedEvent.post($0, to: pid) }
        )
    }

    private static func keyboardWindow(pid: pid_t) throws -> WindowGeometry.Window {
        try SnapshotKeyboardWindow.resolve(
            pid: pid,
            snapshot: AXTree.snapshotEvidence(pid: pid),
            currentIdentity: AXTree.currentProcessIdentity(pid: pid),
            windowForID: { WindowGeometry.window(id: $0, pid: $1) }
        )
    }

    private static func validateKeyboardWindow(_ window: WindowGeometry.Window, pid: pid_t) throws {
        guard WindowGeometry.window(id: window.id, pid: pid) == window else {
            throw CUError("stale_window", "The keyboard target window moved or closed. Read its current state before retrying.")
        }
    }

    // MARK: - Drag

    /// Synthetic left-button (or `button`) drag between two GLOBAL points: down at
    /// `from`, ten interpolated dragged steps, up at `to`. Posted to the window
    /// explicitly resolved target via `postToPid`. Coordinate-only by contract —
    /// the model drives drags by pixel, not by element index.
    public static func drag(pid: pid_t, from: CGPoint, to: CGPoint, button: MouseButton = .left) async throws {
        guard let src = eventSource else {
            throw CUError(CUError.Code.eventAlloc, "Failed to allocate a combined-session event source for a drag")
        }

        // Bound to the window under the drag's ORIGIN: a drag that starts inside
        // the target and ends past its edge is ordinary (dragging something out
        // of a list), and re-binding mid-gesture would send the tail of the
        // drag to a different window.
        let dragWindow = try requireBindableWindow(at: from, pid: pid)
        let target = try Injection.authorizeResolvedTarget(pid: pid)
        let focusReceipt = try await ensureTargetAcceptsInput(pid: pid, window: dragWindow)

        // Movement carries clickState 0 (both the leading move and every
        // dragged step); only the press and the release belong to the click.
        // The press and release bracket one gesture and share a number; every
        // movement in between shares a second one.
        let gestureNumber = WindowTargetedEvent.nextEventNumber()
        let motionNumber = WindowTargetedEvent.nextEventNumber()
        var specs = [
            MouseBurstSpec(
                type: .mouseMoved,
                point: from,
                button: button,
                clickState: mouseClickState(for: .mouseMoved, click: 1),
                eventNumber: motionNumber
            ),
            MouseBurstSpec(
                type: button.down,
                point: from,
                button: button,
                clickState: mouseClickState(for: button.down, click: 1),
                eventNumber: gestureNumber
            ),
        ]
        for step in 1...10 {
            let t = CGFloat(step) / 10
            let p = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
            specs.append(MouseBurstSpec(
                type: button.dragged,
                point: p,
                button: button,
                clickState: mouseClickState(for: button.dragged, click: 1),
                eventNumber: motionNumber
            ))
        }
        specs.append(MouseBurstSpec(
            type: button.up,
            point: to,
            button: button,
            clickState: mouseClickState(for: button.up, click: 1),
            eventNumber: gestureNumber
        ))
        let events: [CGEvent] = try EventBurst.allocateAll(
            specs: specs
        ) { spec in
            makeMouse(spec, source: src, targetPid: pid, window: dragWindow)
        }
        try await postMouseBurst(
            events, target: target, window: dragWindow, button: button, focusReceipt: focusReceipt
        )
    }

    private static func postMouseBurst(
        _ events: [CGEvent], target: ProvenProcessTarget,
        window: WindowGeometry.Window, button: MouseButton,
        focusReceipt: FocusEventMonitor.RegistrationReceipt,
        pause: (@MainActor () async throws -> Void)? = {
            try await Task.sleep(for: .milliseconds(30))
        }
    ) async throws {
        try await MouseEventBurstDelivery.deliver(
            events: events,
            validate: {
                _ = try Injection.validateAuthorizedTarget(target)
                try SyntheticWindowFocus.validate(focusReceipt)
                guard WindowGeometry.window(id: window.id, pid: target.pid) == window else {
                    throw CUError("stale_window", "The target window moved or closed. Read its current state before retrying.")
                }
            },
            post: { WindowTargetedEvent.post($0, to: target.pid) },
            release: { down, point in
                // A canceled gesture still needs its up, but never at a new
                // process that happened to reuse the original PID.
                _ = try Injection.validateAuthorizedTarget(target)
                guard let liveWindow = WindowGeometry.window(id: window.id, pid: target.pid),
                      let nsType = Injection.nsEventType(for: button.up),
                      let up = WindowTargetedEvent.makeMouseEvent(
                        type: button.up, nsType: nsType, point: point, button: button,
                        clickCount: Int(down.getIntegerValueField(.mouseEventClickState)),
                        windowID: liveWindow.id, windowBounds: liveWindow.bounds,
                        eventNumber: Int(down.getIntegerValueField(.mouseEventNumber))
                      ) else { return }
                WindowTargetedEvent.post(up, to: target.pid)
            },
            pause: pause
        )
    }

    // ════════════════════════════════════════════════════════════════════════
    // MARK: - Internals
    // ════════════════════════════════════════════════════════════════════════

    /// Resolve and validate the CURRENT AX element through AXTree. The router's
    /// coarse snapshot/range/process guards never substitute for this semantic
    /// refetch immediately before an index action.
    private static func resolveElement(pid: pid_t, index: Int) throws -> AXUIElement {
        try AXTree.refetch(pid: pid, index: index)
    }

    // MARK: Click tiers

    /// Try {Press, Confirm, Open} in priority order. Returns the tag of the action
    /// that succeeded, or nil if none is exposed / all failed softly. Deliberately
    /// excludes AXShowMenu / AXScrollToVisible so a "click" never opens a menu.
    private static func pressPrimary(_ element: AXUIElement, times: Int) -> String? {
        let available = actionNames(element)
        for (raw, tag) in [(axPress, "press"), (axConfirm, "confirm"), (axOpen, "open")] {
            guard available.contains(raw) else { continue }
            if performAll(raw, on: element, times: times) { return tag }
        }
        return nil
    }

    /// Perform `action` `times` times if the element advertises it; treats benign
    /// AX result codes (unsupported / cannot-complete) as a soft miss → false, so
    /// the gradient can move to the next tier. Returns true only if every rep
    /// succeeded.
    private static func performAll(_ action: String, on element: AXUIElement, times: Int) -> Bool {
        for i in 0..<max(1, times) {
            let err = AXUIElementPerformAction(element, action as CFString)
            switch err {
            case .success:
                if i < times - 1 { Thread.sleep(forTimeInterval: 0.05) }
            case .actionUnsupported, .cannotComplete, .notImplemented, .noValue,
                 .attributeUnsupported, .failure, .invalidUIElement, .illegalArgument:
                return false
            default:
                return false
            }
        }
        return true
    }

    /// Like `performAll` but for the right-click / show-menu / descendant tiers
    /// where we only need "did the action fire at least once".
    @discardableResult
    private static func perform(_ action: String, on element: AXUIElement, times: Int) -> Bool {
        guard actionNames(element).contains(action) else { return false }
        return performAll(action, on: element, times: times)
    }

    /// ① If `element` (or an ancestor within 8 hops) is a row inside an AXList whose
    /// `AXSelectedChildren` is settable, select that row on the list and report
    /// success. This is how sidebars / settings lists are "clicked".
    private static func selectContainingListItem(of element: AXUIElement) -> Bool {
        var directChild = element
        var current = element
        for _ in 0..<8 {
            guard let parent = copyElement(current, kAXParentAttribute) else { return false }
            if stringAttribute(parent, kAXRoleAttribute) == (kAXListRole as String),
               isSettable(parent, kAXSelectedChildrenAttribute) {
                let err = AXUIElementSetAttributeValue(
                    parent,
                    kAXSelectedChildrenAttribute as CFString,
                    [directChild] as CFArray
                )
                return err == .success
            }
            directChild = parent
            current = parent
        }
        return false
    }

    /// ③ Breadth-bounded search (≤`depth` levels) for the first descendant exposing
    /// a Press / Confirm / Open / ShowMenu action.
    private static func firstActionableDescendant(of element: AXUIElement, depth: Int) -> AXUIElement? {
        guard depth > 0 else { return nil }
        for child in children(of: element) {
            let acts = actionNames(child)
            if acts.contains(axPress) || acts.contains(axConfirm) || acts.contains(axOpen) || acts.contains(axShowMenu) {
                return child
            }
            if let deeper = firstActionableDescendant(of: child, depth: depth - 1) {
                return deeper
            }
        }
        return nil
    }

    /// ④ Hit-test the app's element at a GLOBAL point. Bounded messaging timeout so
    /// a wedged renderer can't hang the actor.
    private static func hitTest(pid: pid_t, at point: CGPoint) -> AXUIElement? {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 2.0)
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(app, Float(point.x), Float(point.y), &hit) == .success else {
            return nil
        }
        return hit
    }

    /// Pull a buried window back into view so its app resumes drawing it.
    /// Returns whether the window is actually visible afterwards.
    ///
    /// WINDOW ONLY — this never activates the application
    /// ---------------------------------------------------
    /// `AXRaise` reorders the window without making its application active, so
    /// the user keeps their menu bar and keeps typing wherever they were. That
    /// distinction is the whole point: the target repaints because it is
    /// visible, not because it is focused.
    ///
    /// Deliberately only `AXRaise` — not the `AXMain`/`AXFocused` pair that
    /// `activateWindow` also sets for an explicit activate request. Making a
    /// window main and focused is a plausible route to pulling its app forward,
    /// and un-burying does not need it.
    ///
    /// There used to be a second rung here — `NSRunningApplication.activate`
    /// when the raise was not enough — on the reasoning that a window which
    /// cannot repaint cannot be driven, so one steal was worth a live
    /// screenshot. It is gone. Driving an app while the user works in another
    /// one is the feature; an implementation that yanks their foreground to
    /// take a picture has traded away the thing being bought. When the raise is
    /// not enough the router leaves the target covered. ScreenCaptureKit can
    /// still capture that window independently, and PID/window-targeted input
    /// remains valid; ordinary occlusion is not an input failure.
    ///
    /// This is now only an explicit semantic action. State reads never call it
    /// merely because another application covers the target.
    @discardableResult
    public static func raiseWindow(pid: pid_t, windowID: CGWindowID) -> Bool {
        let app = AXUIElementCreateApplication(pid)
        var value: CFTypeRef?
        if AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success,
           let windows = value as? [AXUIElement] {
            for window in windows where WindowGeometry.axWindowID(of: window) == windowID {
                if actionNames(window).contains(axRaise) {
                    _ = AXUIElementPerformAction(window, axRaise as CFString)
                }
                break
            }
        }
        // The raise is best-effort, so the answer is what the screen shows, not
        // what the AX calls returned.
        return !WindowGeometry.isFullyCovered(windowID: windowID)
    }

    private static func activateWindow(_ element: AXUIElement) -> Bool {
        var activated = false
        if actionNames(element).contains(axRaise),
           AXUIElementPerformAction(element, axRaise as CFString) == .success {
            activated = true
        }
        if setBool(element, kAXMainAttribute) { activated = true }
        if setBool(element, kAXFocusedAttribute) { activated = true }
        return activated
    }

    // MARK: Secondary-action translation (mirror of the renderer's pretty form)

    /// Match a requested secondary-action name (pretty OR raw) to one of the
    /// element's real `AX…` actions. Exact case-insensitive raw match wins; else
    /// compare the requested string against each raw action's PRETTY rendering
    /// (the same transform the tree renderer uses).
    private static func matchAction(requested: String, available: [String]) -> String? {
        let want = requested.trimmingCharacters(in: .whitespaces)
        if let raw = available.first(where: { $0.caseInsensitiveCompare(want) == .orderedSame }) {
            return raw
        }
        return available.first { prettyActionName($0).caseInsensitiveCompare(want) == .orderedSame }
    }

    /// Pretty form of a raw AX action — strip `AX`, drop `ByPage`, split camelCase
    /// (e.g. `AXScrollUpByPage` → `Scroll Up`, `AXRaise` → `Raise`). This is the
    /// documented interop transform (blueprint §1), not copied code; it must stay
    /// in lockstep with the tree renderer so a name the model SEES round-trips back
    /// to the action we PERFORM.
    private static func prettyActionName(_ raw: String) -> String {
        let stripped = raw.hasPrefix("AX") ? String(raw.dropFirst(2)) : raw
        let withoutPage = stripped.replacingOccurrences(of: "ByPage", with: "")
        return splitCamelCase(withoutPage)
    }

    private static func splitCamelCase(_ value: String) -> String {
        var out = ""
        for ch in value {
            if ch.isUppercase, !out.isEmpty { out.append(" ") }
            out.append(ch)
        }
        return out
    }

    // MARK: Scroll synthesis

    /// Synthetic scroll-wheel event at a GLOBAL point, `pages` pages in `direction`
    /// (12 lines/page). Vertical on wheel1, horizontal on wheel2; posted to the
    /// window owner via `postToPid`.
    private static func scrollWheel(at point: CGPoint, direction: String, pages: Double, pid: pid_t) throws {
        let magnitude = Int32(clamping: Int((Double(linesPerPage) * pages).rounded(.toNearestOrAwayFromZero)))
        let amount = max(1, magnitude)
        // Quartz wheel sign: +up / -down (vertical), +left / -right (horizontal).
        let wheel1: Int32 = direction == "up" ? amount : (direction == "down" ? -amount : 0)
        let wheel2: Int32 = direction == "left" ? amount : (direction == "right" ? -amount : 0)
        guard let eventSource else {
            throw CUError(
                CUError.Code.eventAlloc,
                "Failed to allocate a marked scroll-wheel event source"
            )
        }
        guard let event = CGEvent(
            scrollWheelEvent2Source: eventSource,
            units: .line,
            wheelCount: 2,
            wheel1: wheel1,
            wheel2: wheel2,
            wheel3: 0
        ) else {
            throw CUError(CUError.Code.eventAlloc, "Failed to allocate a scroll-wheel event")
        }
        event.location = point
        // Same window binding the click path needs: Chromium routes scroll by
        // the window the event claims, so an unbound wheel event is discarded.
        if let window = WindowGeometry.window(at: point, pid: pid) {
            event.setIntegerValueField(CGEventField(rawValue: 91)!, value: Int64(window.id))
            event.setIntegerValueField(CGEventField(rawValue: 92)!, value: Int64(window.id))
        }
        WindowTargetedEvent.post(event, to: pid)
        Thread.sleep(forTimeInterval: 0.1)
    }

    // MARK: Keyboard helpers

    /// UTF-16 chunks of `text`, each ≤ `unicodeChunk` units, never splitting a
    /// grapheme across a boundary (so multi-scalar emoji stay intact).
    private static func unicodeChunks(_ text: String) -> [[UniChar]] {
        var chunks: [[UniChar]] = []
        var current: [UniChar] = []
        for ch in text {
            let units = Array(String(ch).utf16)
            if !current.isEmpty, current.count + units.count > unicodeChunk {
                chunks.append(current)
                current.removeAll(keepingCapacity: true)
            }
            current.append(contentsOf: units)
        }
        if !current.isEmpty { chunks.append(current) }
        return chunks
    }

    /// Post literal Unicode to the explicitly-targeted pid. Event allocation is
    /// fail-closed so a partial synthetic edit is never silently followed by a
    /// clipboard paste of the full string.
    private static func postUnicodeText(pid: pid_t, text: String) throws {
        guard let src = eventSource else {
            throw CUError(CUError.Code.eventAlloc, "Failed to allocate a Unicode event source")
        }
        var events: [(down: CGEvent, up: CGEvent)] = []
        for chunk in unicodeChunks(text) {
            var buffer = chunk
            guard let down = CGEvent(
                keyboardEventSource: src,
                virtualKey: 0,
                keyDown: true
            ), let up = CGEvent(
                keyboardEventSource: src,
                virtualKey: 0,
                keyDown: false
            ) else {
                throw CUError(CUError.Code.eventAlloc, "Failed to allocate a Unicode key event")
            }
            buffer.withUnsafeMutableBufferPointer { pointer in
                guard let base = pointer.baseAddress else { return }
                down.keyboardSetUnicodeString(
                    stringLength: pointer.count,
                    unicodeString: base
                )
                up.keyboardSetUnicodeString(
                    stringLength: pointer.count,
                    unicodeString: base
                )
            }
            events.append((down, up))
        }
        for event in events {
            event.down.postToPid(pid)
            event.up.postToPid(pid)
            Thread.sleep(forTimeInterval: 0.02)
        }
    }

    // MARK: Mouse synthesis

    /// Allocate one mouse event without posting it. Callers allocate their full
    /// gesture first, then post the completed burst via `postToPid`.
    /// Build one synthetic mouse event, bound to the window under the point.
    ///
    /// This is the path a COORDINATE click actually takes: `clickAtPoint` falls
    /// through to `clickPoint` whenever no AX element answers — exactly the
    /// Chromium/CEF case. A bare `CGEvent` carries no window identity, and
    /// Chromium routes input by the window an event claims, so the window-less
    /// form is silently discarded: "Action completed", nothing happens.
    ///
    /// This file used to build its own window-less event while `Injection` had
    /// the window-bound one — two parallel implementations, and the fix landed
    /// in the half the product does not use for coordinate clicks.
    /// - Parameter window: the already-resolved target window. Callers resolve
    ///   it once for the whole burst (see `requireBindableWindow`) so every
    ///   event names the same window even if the window moves mid-gesture, and
    ///   so "no window to name" is refused up front instead of silently
    ///   producing unbound events a custom renderer will discard.
    private static func makeMouse(
        _ spec: MouseBurstSpec,
        source: CGEventSource,
        targetPid: pid_t? = nil,
        window: WindowGeometry.Window? = nil
    ) -> CGEvent? {
        if let nsType = Injection.nsEventType(for: spec.type),
           targetPid != nil,
           let window,
           let bound = WindowTargetedEvent.makeMouseEvent(
               type: spec.type,
               nsType: nsType,
               point: spec.point,
               button: spec.button,
               // Passed through, NOT floored at 1. A `max(1, …)` here used to
               // silently re-raise movement back to "click 1" after the caller
               // had deliberately marked it 0. Press and release always supply
               // 1…N themselves, so nothing needs a floor.
               clickCount: spec.clickState,
               windowID: window.id,
               windowBounds: window.bounds,
               eventNumber: spec.eventNumber
           ) {
            bound.setIntegerValueField(
                .mouseEventClickState,
                value: Int64(spec.clickState)
            )
            return bound
        }

        guard let event = CGEvent(
            mouseEventSource: source,
            mouseType: spec.type,
            mouseCursorPosition: spec.point,
            mouseButton: spec.button.cg
        ) else { return nil }
        event.setIntegerValueField(
            .mouseEventClickState,
            value: Int64(spec.clickState)
        )
        return event
    }

    // MARK: Element metadata

    /// Global (Quartz) center of a record's frame, if it has one.
    private static func centerGlobal(_ record: AXTree.Element?) -> CGPoint? {
        guard let f = record?.frameGlobal else { return nil }
        return CGPoint(x: f.x + f.w / 2, y: f.y + f.h / 2)
    }

    private static func isWindowRole(_ record: AXTree.Element?) -> Bool {
        record?.role == (kAXWindowRole as String)
    }

    /// True if the element is a focusable free-text entry control (text field /
    /// area / view) — the only roles the Unicode keyboard fallback may type into.
    private static func isTextEntry(_ element: AXUIElement) -> Bool {
        guard let role = stringAttribute(element, kAXRoleAttribute) else { return false }
        if role == (kAXTextFieldRole as String) || role == (kAXTextAreaRole as String) || role == "AXTextView" {
            return true
        }
        if let rd = stringAttribute(element, kAXRoleDescriptionAttribute)?.lowercased() {
            return rd.contains("text field") || rd.contains("text area") || rd.contains("text entry")
        }
        return false
    }

    /// The app's current `kAXFocusedUIElement`, bounded by a messaging timeout.
    private static func focusedElement(of pid: pid_t) -> AXUIElement? {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 2.0)
        return copyElement(app, kAXFocusedUIElementAttribute)
    }

    // MARK: Raw AX accessors (CF-safe, main-actor)

    private static func actionNames(_ element: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success, let names else { return [] }
        return (names as? [String]) ?? []
    }

    private static func children(of element: AXUIElement) -> [AXUIElement] {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success,
              let value, CFGetTypeID(value) == CFArrayGetTypeID()
        else { return [] }
        let arr = value as! [AnyObject]
        var out: [AXUIElement] = []
        out.reserveCapacity(arr.count)
        for obj in arr {
            let ref = obj as CFTypeRef
            if CFGetTypeID(ref) == AXUIElementGetTypeID() { out.append(ref as! AXUIElement) }
        }
        return out
    }

    private static func copyElement(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let value, CFGetTypeID(value) == AXUIElementGetTypeID()
        else { return nil }
        return (value as! AXUIElement)
    }

    /// Read an attribute as a display string (CFString / CFNumber / CFBoolean).
    /// Geometry (AXValue) returns nil here by design.
    private static func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let value
        else { return nil }
        let id = CFGetTypeID(value)
        if id == CFStringGetTypeID() {
            let s = (value as! CFString) as String
            return s.isEmpty ? nil : s
        }
        if id == CFNumberGetTypeID() { return "\((value as! NSNumber))" }
        if id == CFBooleanGetTypeID() { return CFBooleanGetValue((value as! CFBoolean)) ? "true" : "false" }
        return nil
    }

    /// Read a text value while preserving the empty string (unlike the display
    /// metadata accessor above, where empty values are intentionally omitted).
    private static func textValueAttribute(_ element: AXUIElement) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element,
            kAXValueAttribute as CFString,
            &value
        ) == .success,
              let value,
              CFGetTypeID(value) == CFStringGetTypeID()
        else { return nil }
        return (value as! CFString) as String
    }

    private static func selectedTextRange(_ element: AXUIElement) -> NSRange? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element,
            kAXSelectedTextRangeAttribute as CFString,
            &raw
        ) == .success,
              let raw,
              CFGetTypeID(raw) == AXValueGetTypeID()
        else { return nil }

        let value = raw as! AXValue
        guard AXValueGetType(value) == .cfRange else { return nil }
        var range = CFRange()
        guard AXValueGetValue(value, .cfRange, &range),
              range.location >= 0,
              range.length >= 0
        else { return nil }
        return NSRange(location: range.location, length: range.length)
    }

    private static func setSelectedTextRange(
        _ element: AXUIElement,
        _ range: NSRange
    ) throws {
        var cfRange = CFRange(location: range.location, length: range.length)
        guard let value = AXValueCreate(.cfRange, &cfRange) else {
            throw CUError("ax_failed", "Could not encode the selected text range")
        }
        let error = AXUIElementSetAttributeValue(
            element,
            kAXSelectedTextRangeAttribute as CFString,
            value
        )
        guard error == .success else {
            throw CUError(
                "ax_failed",
                "Setting the selected text range failed (AXError \(error.rawValue))"
            )
        }
    }

    private static func isSettable(_ element: AXUIElement, _ attribute: String) -> Bool {
        var settable: DarwinBoolean = false
        return AXUIElementIsAttributeSettable(element, attribute as CFString, &settable) == .success && settable.boolValue
    }

    @discardableResult
    private static func setBool(_ element: AXUIElement, _ attribute: String) -> Bool {
        guard isSettable(element, attribute) else { return false }
        return AXUIElementSetAttributeValue(element, attribute as CFString, kCFBooleanTrue) == .success
    }

    private static func sameElement(_ lhs: AXUIElement?, _ rhs: AXUIElement?) -> Bool {
        guard let lhs, let rhs else { return false }
        return CFEqual(lhs, rhs)
    }

    /// Settlement is recorded once at `ForegroundMutationRunner`, which covers
    /// every input path and knows the target PID. AX-local success receipts must
    /// not create a second, unscoped marker that can leak across apps.
    private static func settle() {
        // Intentionally empty; retained at the AX call sites as a semantic
        // marker for successful mutations.
    }
}
