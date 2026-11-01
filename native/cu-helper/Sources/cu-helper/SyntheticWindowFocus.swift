import AppKit
import CoreGraphics
import Foundation
import os

/// Synthetic activation is not the user's real foreground. Its lifetime must
/// follow observed focus changes, not just whether a notification was once sent.
enum SyntheticWindowFocus {
    enum Notification: Int32, Sendable {
        case appActivated = 1
        case appDeactivated = 2
        case lostKeyFocus = 0x1000
        case keyFocusTaken = 0x4000
        case keyFocusReturned = 0x8000

        var subtype: Int16 { Int16(truncatingIfNeeded: rawValue) }
        var carrierEventType: NSEvent.EventType? {
            switch self {
            case .appActivated, .appDeactivated: .appKitDefined
            case .lostKeyFocus, .keyFocusTaken, .keyFocusReturned:
                NSEvent.EventType(rawValue: Self.keyFocusCarrierRawValue)
            }
        }
        static let keyFocusCarrierRawValue: UInt = 21
    }

    struct Window: Equatable, Sendable {
        let id: CGWindowID
        let bounds: CGRect
        // The outer optional records whether AX supplied the attribute. A
        // failed query requires generic activation; a supplied but undecodable
        // point still allows window activation, without inventing a click.
        let activationPoint: CGPoint??

        var resolvedActivationPoint: CGPoint? { activationPoint ?? nil }
    }

    enum Establishment: Equatable, Sendable {
        case activate
        case returnFocus
        case none
    }

    struct Belief: Equatable, Sendable {
        let identity: AXTreeProcessIdentity
        var applicationIsActive: Bool
        var applicationBelievesItIsActive: Bool
        var applicationBelievesItHasFocus: Bool
        var generation: UInt64 = 0
    }

    struct State: Sendable {
        private(set) var targets: [pid_t: Belief] = [:]

        mutating func prepare(
            pid: pid_t, identity: AXTreeProcessIdentity,
            applicationIsActive: Bool, applicationHasFocus: Bool
        ) -> (Establishment, UInt64) {
            if targets[pid]?.identity != identity {
                targets[pid] = Belief(
                    identity: identity, applicationIsActive: applicationIsActive,
                    applicationBelievesItIsActive: applicationIsActive,
                    applicationBelievesItHasFocus: applicationHasFocus
                )
            } else if targets[pid]?.applicationIsActive != applicationIsActive {
                observeApplication(pid: pid, active: applicationIsActive)
            }
            guard let belief = targets[pid] else { return (.none, 0) }
            if belief.applicationBelievesItHasFocus { return (.none, belief.generation) }
            return (belief.applicationBelievesItIsActive ? .returnFocus : .activate, belief.generation)
        }

        mutating func observeApplication(pid: pid_t, active: Bool) {
            guard var belief = targets[pid] else { return }
            let wasActive = belief.applicationIsActive
            belief.applicationIsActive = active
            // Background -> background must preserve the synthetic field focus.
            if active || wasActive {
                if belief.applicationBelievesItIsActive != active
                    || belief.applicationBelievesItHasFocus != active {
                    belief.generation &+= 1
                }
                belief.applicationBelievesItIsActive = active
                belief.applicationBelievesItHasFocus = active
            }
            targets[pid] = belief
        }

        mutating func observeFrontmost(pid: pid_t) {
            for target in Array(targets.keys) {
                observeApplication(pid: target, active: target == pid)
            }
        }

        mutating func observeDeactivation(pid: pid_t) {
            guard var belief = targets[pid] else { return }
            belief.applicationIsActive = false
            belief.applicationBelievesItIsActive = false
            belief.applicationBelievesItHasFocus = false
            belief.generation &+= 1
            targets[pid] = belief
        }

        mutating func observeFocus(pid: pid_t, hasFocus: Bool) {
            guard var belief = targets[pid] else { return }
            belief.applicationBelievesItHasFocus = hasFocus
            // A loss during an in-flight establishment invalidates its receipt
            // even when the old belief was already false. A gain can confirm it.
            if !hasFocus { belief.generation &+= 1 }
            targets[pid] = belief
        }

        mutating func confirm(pid: pid_t, identity: AXTreeProcessIdentity, generation: UInt64) -> Bool {
            guard var belief = targets[pid], belief.identity == identity,
                  belief.generation == generation else { return false }
            belief.applicationBelievesItIsActive = true
            belief.applicationBelievesItHasFocus = true
            targets[pid] = belief
            return true
        }

        mutating func invalidate(pid: pid_t, identity: AXTreeProcessIdentity) {
            guard targets[pid]?.identity == identity else { return }
            targets[pid]?.applicationBelievesItIsActive = false
            targets[pid]?.applicationBelievesItHasFocus = false
            targets[pid]?.generation &+= 1
        }

        mutating func drain() -> [pid_t: Belief] {
            defer { targets.removeAll() }
            return targets
        }
    }

    struct Runtime: Sendable {
        var identity: @MainActor @Sendable (pid_t) -> AXTreeProcessIdentity?
        var isActive: @MainActor @Sendable (pid_t) -> Bool
        var hasFocus: @MainActor @Sendable (pid_t) -> Bool
        var acceptsInput: @MainActor @Sendable (pid_t) -> Bool
        /// True only when the app answered that it is not active. A timeout is
        /// not an answer, so it can never trigger a fresh activation.
        var deniesActivation: @MainActor @Sendable (pid_t) -> Bool = { _ in false }
        /// A hidden app drops input until it is shown, and a full synthetic
        /// activation is what shows it — without taking the user's foreground.
        var isHidden: @MainActor @Sendable (pid_t) -> Bool = { _ in false }
        var post: @MainActor @Sendable (Establishment, pid_t, Window?) -> Bool
        var pause: @Sendable () async throws -> Void
        var attempts: Int = 20
        var validateContinuity: @MainActor @Sendable () throws -> Void = {}
    }

    final class Coordinator: Sendable {
        private let state = OSAllocatedUnfairLock(initialState: State())

        func observeFrontmost(pid: pid_t) { state.withLock { $0.observeFrontmost(pid: pid) } }
        func observeDeactivation(pid: pid_t) { state.withLock { $0.observeDeactivation(pid: pid) } }
        func observeFocus(pid: pid_t, hasFocus: Bool) {
            state.withLock { $0.observeFocus(pid: pid, hasFocus: hasFocus) }
        }
        func drain() -> [pid_t: Belief] { state.withLock { $0.drain() } }
        var beliefs: [pid_t: Belief] { state.withLock { $0.targets } }

        @MainActor
        func prepare(pid: pid_t, window: Window?, runtime: Runtime) async throws {
            try Task.checkCancellation()
            try runtime.validateContinuity()
            guard pid > 0, let identity = runtime.identity(pid) else {
                throw CUError("process_gone", "The input target is no longer running.")
            }
            let active = runtime.isActive(pid)
            let focused = runtime.hasFocus(pid)
            let cached = state.withLock {
                $0.prepare(pid: pid, identity: identity, applicationIsActive: active, applicationHasFocus: focused)
            }
            // A cached focus the target itself contradicts is stale. Minimizing
            // and restoring its window dropped the synthetic activation with no
            // focus notification (measured on Chromium: AXFrontmost 0 while the
            // belief still held focus), so establish it again rather than fail.
            // Never for the user's real frontmost app, and never on a timeout:
            // the activation click would land in the window they are using.
            // A hidden app needs the full activation whatever the cache says:
            // with focus cached, a click into it was dropped and it stayed
            // hidden (measured on Chromium behind a fullscreen app).
            let isStale = cached.0 != .activate && !active && (
                runtime.isHidden(pid) || (cached.0 == .none && runtime.deniesActivation(pid))
            )
            let (establishment, generation) = !isStale ? cached : state.withLock {
                $0.invalidate(pid: pid, identity: identity)
                return $0.prepare(
                    pid: pid, identity: identity,
                    applicationIsActive: active, applicationHasFocus: focused
                )
            }
            try Task.checkCancellation()
            try runtime.validateContinuity()
            if establishment != .none, !runtime.post(establishment, pid, window) {
                state.withLock { $0.invalidate(pid: pid, identity: identity) }
                throw CUError("focus_event_failed", "Could not construct the target window's activation event.")
            }
            do {
                // Yield the main actor so both the target and lifecycle observers
                // can run; a fixed blocking sleep hid focus changes in the past.
                if establishment != .none { try await runtime.pause() }
                for attempt in 0...max(0, runtime.attempts) {
                    try Task.checkCancellation()
                    try runtime.validateContinuity()
                    guard runtime.identity(pid) == identity else {
                        throw CUError("stale_process", "The input target restarted while establishing focus.")
                    }
                    if runtime.acceptsInput(pid) {
                        try runtime.validateContinuity()
                        guard state.withLock({ $0.confirm(pid: pid, identity: identity, generation: generation) }) else {
                            throw CUError("focus_changed", "The target lost focus while preparing input. Read its current state before retrying.")
                        }
                        return
                    }
                    if attempt < runtime.attempts { try await runtime.pause() }
                }
                throw CUError("focus_not_accepted", "The target did not acknowledge activation. Input was not sent; read its current state before retrying.")
            } catch {
                state.withLock { $0.invalidate(pid: pid, identity: identity) }
                throw error
            }
        }
    }

    /// Consume the notification itself, including a delayed activate -> leave
    /// pair. Checking today's frontmost PID would silently discard that history.
    final class ApplicationLifecycleObserver: @unchecked Sendable {
        private let center: NotificationCenter
        private var tokens: [NSObjectProtocol] = []

        init(
            center: NotificationCenter, coordinator: Coordinator,
            onFrontmost: @escaping @Sendable (pid_t) -> Void = { _ in }
        ) {
            self.center = center
            tokens.append(center.addObserver(
                forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: nil
            ) { notification in
                guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey]
                    as? NSRunningApplication else { return }
                coordinator.observeFrontmost(pid: app.processIdentifier)
                onFrontmost(app.processIdentifier)
            })
            tokens.append(center.addObserver(
                forName: NSWorkspace.didDeactivateApplicationNotification, object: nil, queue: nil
            ) { notification in
                guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey]
                    as? NSRunningApplication else { return }
                coordinator.observeDeactivation(pid: app.processIdentifier)
            })
        }

        deinit { for token in tokens { center.removeObserver(token) } }
    }

    private static let coordinator = Coordinator()
    static var beliefs: [pid_t: Belief] { coordinator.beliefs }
    @MainActor private(set) static var lastPreparedWindow: (pid: pid_t, window: Window?)?
    private static let applicationObserver = ApplicationLifecycleObserver(
        center: NSWorkspace.shared.notificationCenter, coordinator: coordinator,
        onFrontmost: { FocusEventMonitor.shared.observeRealFrontmost(pid: $0) }
    )

    @MainActor
    @discardableResult
    static func prepareInput(
        pid: pid_t, window: WindowGeometry.Window? = nil,
        beforeFocus: (@MainActor (FocusEventMonitor.RegistrationReceipt) async throws -> Void)? = nil
    ) async throws -> FocusEventMonitor.RegistrationReceipt {
        try Task.checkCancellation()
        _ = applicationObserver
        let geometry = window ?? WindowGeometry.frontmostWindow(pid: pid)
        let context = geometry.map {
            Window(id: $0.id, bounds: $0.bounds, activationPoint: activationPoint(pid: pid, window: $0))
        }
        lastPreparedWindow = (pid, context)
        let monitor = FocusEventMonitor.shared
        return try await prepareInput(pid: pid, window: context, monitor: monitor, coordinator: coordinator, runtime: Runtime(
            identity: { AXTree.currentProcessIdentity(pid: $0) },
            isActive: { NSWorkspace.shared.frontmostApplication?.processIdentifier == $0 },
            hasFocus: { monitor.isAppCurrentlyFocused(pid: $0) },
            acceptsInput: { acceptsInput(pid: $0) },
            deniesActivation: { deniesActivation(pid: $0) },
            isHidden: { NSRunningApplication(processIdentifier: $0)?.isHidden == true },
            post: { establishment, pid, window in
                switch establishment {
                case .none: return true
                case .returnFocus: return post(.keyFocusReturned, to: pid)
                case .activate:
                    guard let events = activationEvents(window: activationWindow(
                        window, appIsHidden: NSRunningApplication(processIdentifier: pid)?.isHidden == true
                    )) else { return false }
                    for event in events { WindowTargetedEvent.post(event, to: pid) }
                    return true
                }
            },
            pause: { try await Task.sleep(for: .milliseconds(100)) }
        ), beforeFocus: beforeFocus)
    }

    /// Register protection before any preparatory pointer event, and preserve
    /// that exact receipt across both the pointer delay and focus establishment.
    @MainActor
    static func prepareInput(
        pid: pid_t, window: Window?, monitor: FocusEventMonitor,
        coordinator: Coordinator, runtime: Runtime,
        beforeFocus: (@MainActor (FocusEventMonitor.RegistrationReceipt) async throws -> Void)? = nil
    ) async throws -> FocusEventMonitor.RegistrationReceipt {
        try Task.checkCancellation()
        guard monitor.register(pid: pid, onFocusChanged: { hasFocus in
            coordinator.observeFocus(pid: pid, hasFocus: hasFocus)
        }) else {
            throw CUError("focus_monitor_unavailable", "Cannot observe target focus safely. No input was sent.")
        }
        guard let receipt = monitor.registrationReceipt(pid: pid) else {
            throw CUError("focus_monitor_interrupted", "Focus monitoring changed while preparing input.")
        }
        try validate(receipt, monitor: monitor)
        try await beforeFocus?(receipt)
        try Task.checkCancellation()
        try validate(receipt, monitor: monitor)
        var protectedRuntime = runtime
        protectedRuntime.validateContinuity = {
            try runtime.validateContinuity()
            try validate(receipt, monitor: monitor)
        }
        try await coordinator.prepare(pid: pid, window: window, runtime: protectedRuntime)
        return receipt
    }

    static func validate(
        _ receipt: FocusEventMonitor.RegistrationReceipt?,
        monitor: FocusEventMonitor = .shared
    ) throws {
        guard let receipt, monitor.isRegistrationCurrent(receipt) else {
            throw CUError("focus_monitor_interrupted", "Focus monitoring changed before input could be sent.")
        }
    }

    /// A hidden app's window ignored the window-bound activation and stayed
    /// hidden, so the click that followed was dropped. The app-level
    /// activation shows the app again without taking the user's foreground
    /// (measured on Chromium behind a fullscreen app).
    static func activationWindow(_ window: Window?, appIsHidden: Bool) -> Window? {
        appIsHidden ? nil : window
    }

    /// The reference's window-bound AppKit activation protocol. The 0xc0000
    /// bits here are not physical keyboard modifiers to press or hold.
    static func activationEvents(window: Window?) -> [CGEvent]? {
        // Codex uses app-level activation when AXActivationPoint is unsupported
        // or unavailable. Keeping the window number here changes the protocol.
        let activationWindow = window.flatMap { $0.activationPoint == nil ? nil : $0 }
        let windowID = activationWindow?.id ?? kCGNullWindowID
        guard let event = notificationEvent(
            .appActivated, windowID: windowID,
            flags: windowID == kCGNullWindowID ? [] : NSEvent.ModifierFlags(rawValue: 0xc0000)
        ) else { return nil }
        var events = [event]
        if let window = activationWindow, let point = window.resolvedActivationPoint,
           window.id != kCGNullWindowID, point.x.isFinite, point.y.isFinite {
            // Use only the window's explicit AXActivationPoint. A guessed center
            // could activate an unrelated or destructive control. Custom-shell
            // apps can supply an out-of-content point (NetEase: -1, screenH+1);
            // the reference still delivers that activation click to this PID
            // and window, never through the physical pointer or a hit-test.
            let strokes: [(CGEventType, NSEvent.EventType, Int)] = [
                (.leftMouseDown, .leftMouseDown, 1), (.leftMouseUp, .leftMouseUp, 2),
            ]
            for (type, nsType, number) in strokes {
                guard let mouse = WindowTargetedEvent.makeMouseEvent(
                    type: type, nsType: nsType, point: point, button: .left,
                    clickCount: 1, windowID: window.id, windowBounds: window.bounds,
                    eventNumber: number
                ) else { return nil }
                events.append(mouse)
            }
        }
        return events
    }

    static func notificationEvent(
        _ notification: Notification,
        windowID: CGWindowID = kCGNullWindowID,
        flags: NSEvent.ModifierFlags = []
    ) -> CGEvent? {
        guard let carrier = notification.carrierEventType else { return nil }
        return NSEvent.otherEvent(
            with: carrier, location: .zero, modifierFlags: flags,
            timestamp: 0, windowNumber: Int(windowID), context: nil,
            subtype: notification.subtype, data1: 0, data2: 0
        )?.cgEvent
    }

    @discardableResult
    static func post(_ notification: Notification, to pid: pid_t) -> Bool {
        guard pid > 0, let event = notificationEvent(notification) else { return false }
        WindowTargetedEvent.post(event, to: pid)
        return true
    }

    private static func deniesActivation(pid: pid_t) -> Bool {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.1)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXFrontmostAttribute as CFString, &value) == .success else {
            return false
        }
        return (value as? NSNumber)?.boolValue == false
    }

    private static func acceptsInput(pid: pid_t) -> Bool {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.1)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXFrontmostAttribute as CFString, &value) == .success else {
            return false
        }
        return (value as? NSNumber)?.boolValue == true
    }

    @MainActor
    private static func activationPoint(pid: pid_t, window: WindowGeometry.Window) -> CGPoint?? {
        guard let element = try? AXTree.snapshotWindowElement(pid: pid, windowID: window.id) else { return nil }
        AXUIElementSetMessagingTimeout(element, 0.1)
        var raw: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(element, "AXActivationPoint" as CFString, &raw)
        return decodeActivationPoint(error: error, raw: raw)
    }

    static func decodeActivationPoint(error: AXError, raw: CFTypeRef?) -> CGPoint?? {
        guard error == .success, let raw else { return nil }
        guard CFGetTypeID(raw) == AXValueGetTypeID() else { return .some(nil) }
        var point = CGPoint.zero
        guard AXValueGetValue(unsafeDowncast(raw, to: AXValue.self), .cgPoint, &point),
              point.x.isFinite, point.y.isFinite else { return .some(nil) }
        return .some(point)
    }

    @MainActor
    static func relinquishAll() {
        FocusEventMonitor.shared.unregisterAll()
        let targets = coordinator.drain()
        for (pid, belief) in targets {
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier != pid,
                  AXTree.currentProcessIdentity(pid: pid) == belief.identity else { continue }
            post(.lostKeyFocus, to: pid)
            post(.appDeactivated, to: pid)
        }
    }
}
