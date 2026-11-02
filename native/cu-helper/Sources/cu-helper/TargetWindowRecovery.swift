import AppKit

/// Makes an explicitly authorized app actionable without ever taking the
/// user's foreground, keyboard, or pointer.
///
/// Measured on a real machine, with the user in a fullscreen app on the same
/// display and the target behind it:
/// - A window on another Space takes PID/window-targeted clicks and Unicode
///   keys, so it is left exactly where the user put it. Our own desktop window
///   uses native fullscreen, so this is the normal state while the user
///   watches the agent from it.
/// - A hidden app (⌘H) still exposes its windows to AX and takes input; the
///   synthetic activation before an action shows it again without taking the
///   foreground. Like the reference, a read leaves it hidden.
/// - A minimized window takes no input. AXMinimized=false restores it without
///   activating the app. A window restored while its Space is not shown keeps
///   refusing input until the user visits that Space; it is recorded as
///   parked so actions are refused instead of reported as delivered.
/// - An app with no window at all gets the reference's non-activating reopen
///   through LaunchServices.
///
/// Activation itself is never requested; it was what dragged the user back to
/// the target's Space on every read.
@MainActor
enum TargetWindowRecovery {
    enum Outcome: Equatable {
        case alreadyActionable
        case recovered
        /// Restored from the Dock onto a Space the user is not looking at.
        case restoredOffScreen
        /// The app did not answer accessibility queries; nothing was changed.
        case unknown
    }

    enum Actionability: Equatable {
        case actionable
        case notActionable
        case unknown
    }

    enum Request: Equatable {
        case refused
        case deminiaturized(CGWindowID?)
        case reopened
    }

    /// The state of one window that is not on the Spaces being shown.
    enum WindowState: Equatable {
        case takesInput
        case minimized
        case parked
        /// AX no longer lists it: closed, or out of AX's reach.
        case gone
        case unknown
    }

    /// Windows restored from the Dock while their Space was not shown. macOS
    /// holds their input until the user visits that Space.
    final class ParkedWindows {
        private var windows: [pid_t: (identity: AXTreeProcessIdentity, ids: Set<CGWindowID>)] = [:]

        func park(_ target: ProvenProcessTarget, windowID: CGWindowID) {
            var ids = windows[target.pid]?.identity == target.identity
                ? windows[target.pid]?.ids ?? [] : []
            ids.insert(windowID)
            windows[target.pid] = (target.identity, ids)
        }

        func isParked(pid: pid_t, identity: AXTreeProcessIdentity?, windowID: CGWindowID) -> Bool {
            guard let entry = windows[pid], entry.identity == identity else { return false }
            return entry.ids.contains(windowID)
        }

        /// The user showed the Space: input flows again.
        func release(pid: pid_t) {
            windows[pid] = nil
        }
    }

    static let parked = ParkedWindows()

    struct Runtime {
        var currentIdentity: (pid_t) -> AXTreeProcessIdentity?
        var actionability: (pid_t) -> Actionability
        var isOnScreen: (pid_t) -> Bool
        var requestRecovery: (ProvenProcessTarget) -> Request
        var pause: () async throws -> Void
        var attempts: Int = 20
        /// A restored window needs a moment to appear on a shown Space.
        var settleAttempts: Int = 10
        var parked: ParkedWindows
        /// Starts before a recovery request and finishes after it, on success
        /// and failure alike. An app may still answer a restore by activating
        /// itself; the router hands the foreground back to the user's app.
        var guardForeground: (ProvenProcessTarget) -> @MainActor () async -> Void = { _ in {} }

        @MainActor static func live(
            native: NativeRuntime = .live,
            parked: ParkedWindows = TargetWindowRecovery.parked,
            onScreen: @escaping (pid_t) -> Bool = { WindowGeometry.hasWindowOnScreen(pid: $0) }
        ) -> Runtime {
            Runtime(
                currentIdentity: { AXTree.currentProcessIdentity(pid: $0) },
                actionability: { pid in
                    TargetWindowRecovery.actionability(
                        onScreen: onScreen(pid),
                        windowMinimizedStates: native.application(pid)?.windows()?.map { $0.isMinimized() }
                    )
                },
                isOnScreen: onScreen,
                requestRecovery: { requestNativeRecovery(target: $0, runtime: native) },
                pause: { try await Task.sleep(for: .milliseconds(100)) },
                parked: parked
            )
        }
    }

    /// Type-erased native handles keep the recovery policy testable at the same
    /// seam used by AppKit and AX, without granting tests access to real apps.
    struct NativeWindow {
        var id: () -> CGWindowID? = { nil }
        var isMinimized: () -> Bool?
        var setMinimized: (Bool) -> Bool
        var makeMain: () -> Bool = { false }
    }

    struct NativeApplication {
        let identity: AXTreeProcessIdentity
        var isTerminated: () -> Bool
        /// nil when the app did not answer: that says nothing about its windows.
        var windows: () -> [NativeWindow]?
        var reopenInBackground: () -> Bool
    }

    struct NativeRuntime {
        var application: (pid_t) -> NativeApplication?

        @MainActor static let live = NativeRuntime(application: { pid in
            guard let running = NSRunningApplication(processIdentifier: pid) else {
                return nil
            }
            let appElement = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(appElement, axTimeout)
            return NativeApplication(
                identity: AXTreeProcessIdentity(
                    bundleID: running.bundleIdentifier,
                    executablePath: running.executableURL?.path,
                    launchTime: running.launchDate?.timeIntervalSinceReferenceDate
                ),
                isTerminated: { running.isTerminated },
                windows: { windowElements(appElement)?.map { nativeWindow($0) } },
                reopenInBackground: {
                    guard let url = running.bundleURL else { return false }
                    NSWorkspace.shared.openApplication(
                        at: url,
                        configuration: backgroundReopenConfiguration()
                    ) { _, _ in }
                    return true
                }
            )
        })
    }

    /// A responsive app answers in milliseconds. A busy one must not hold the
    /// daemon past the client's request timeout across a whole polling loop.
    static let axTimeout: Float = 0.5

    /// The reference reopens with activation off and without substituting a
    /// different running copy of the bundle. LaunchServices delivers the reopen
    /// event, so no Apple Events (Automation) permission is involved.
    static func backgroundReopenConfiguration() -> NSWorkspace.OpenConfiguration {
        let configuration = AppTargetResolver.openConfiguration(activate: false)
        configuration.allowsRunningApplicationSubstitution = false
        return configuration
    }

    /// Actionable: a window on a shown Space, or a non-minimized window on any
    /// other Space. A window that does not report AXMinimized (a panel, a
    /// dialog) cannot be in the Dock, so it counts. No answer from AX is not a
    /// "no".
    static func actionability(onScreen: Bool, windowMinimizedStates: [Bool?]?) -> Actionability {
        if onScreen { return .actionable }
        guard let states = windowMinimizedStates else { return .unknown }
        return states.contains { $0 != true } ? .actionable : .notActionable
    }

    /// Where an off-screen window stands before input is sent to it.
    static func windowState(
        pid: pid_t,
        windowID: CGWindowID,
        native: NativeRuntime = .live,
        parked: ParkedWindows = TargetWindowRecovery.parked
    ) -> WindowState {
        guard let application = native.application(pid) else { return .gone }
        if parked.isParked(pid: pid, identity: application.identity, windowID: windowID) {
            return .parked
        }
        guard let windows = application.windows() else { return .unknown }
        guard let window = windows.first(where: { $0.id() == windowID }) else { return .gone }
        return window.isMinimized() == true ? .minimized : .takesInput
    }

    /// Revalidates the exact NSRunningApplication object before touching any of
    /// its AX windows. A PID-only lookup is insufficient because macOS can reuse
    /// the number after the explicitly authorized process exits.
    static func requestNativeRecovery(
        target: ProvenProcessTarget,
        runtime: NativeRuntime = .live
    ) -> Request {
        guard let application = runtime.application(target.pid),
              target.validatedPid(currentIdentity: application.identity) != nil,
              !application.isTerminated(),
              let windows = application.windows(),
              !application.isTerminated() else { return .refused }

        if let minimizedWindow = windows.first(where: { $0.isMinimized() == true }) {
            // Deminiaturizing through AX restores this exact window even when
            // the app keeps another window open, where a reopen does nothing.
            guard minimizedWindow.setMinimized(false) else { return .refused }
            // A window restored behind the user's fullscreen app does not
            // become main again, and AX then has no route to it from another
            // Space. AXMain is window ordering inside the app, not activation.
            _ = minimizedWindow.makeMain()
            return .deminiaturized(minimizedWindow.id())
        }
        // Only when AX answered that the app has no window at all, as the
        // reference does when its main window is missing.
        guard windows.isEmpty else { return .refused }
        return application.reopenInBackground() ? .reopened : .refused
    }

    static func recoverIfNeeded(
        target: ProvenProcessTarget,
        runtime: Runtime
    ) async throws -> Outcome {
        try validateIdentity(target, runtime: runtime)
        if runtime.isOnScreen(target.pid) {
            runtime.parked.release(pid: target.pid)
        }
        switch runtime.actionability(target.pid) {
        case .actionable: return .alreadyActionable
        case .unknown: return .unknown
        case .notActionable: break
        }

        let finishForegroundGuard = runtime.guardForeground(target)
        do {
            let outcome = try await recover(target: target, runtime: runtime)
            await finishForegroundGuard()
            return outcome
        } catch {
            await finishForegroundGuard()
            throw error
        }
    }

    private static func recover(
        target: ProvenProcessTarget,
        runtime: Runtime
    ) async throws -> Outcome {
        let request = runtime.requestRecovery(target)

        // The request is asynchronous and AppKit explicitly says acceptance is
        // not proof of a restored window. Check once immediately, then yield
        // the main run loop for a bounded window transition.
        var attempt = 0
        while true {
            try validateIdentity(target, runtime: runtime)
            switch runtime.actionability(target.pid) {
            case .actionable:
                return try await settle(target: target, request: request, runtime: runtime)
            case .unknown:
                throw CUError(
                    "target_window_offscreen",
                    "The target app stopped answering accessibility queries while its window was being restored. No state snapshot was published; read it again once the app responds."
                )
            case .notActionable:
                break
            }
            guard attempt < max(0, runtime.attempts) else { break }
            attempt += 1
            try Task.checkCancellation()
            try await runtime.pause()
        }

        let reason = request == .refused
            ? "macOS refused to restore the target app in the background"
            : "macOS accepted the background restore, but no usable target window appeared"
        throw CUError(
            "target_window_offscreen",
            "Computer Use could not restore the explicitly selected app without bringing it forward: \(reason). No state snapshot was published."
        )
    }

    /// A deminiaturized window that stays off the shown Spaces is parked.
    private static func settle(
        target: ProvenProcessTarget,
        request: Request,
        runtime: Runtime
    ) async throws -> Outcome {
        guard case .deminiaturized(let windowID) = request else { return .recovered }
        for attempt in 0...max(0, runtime.settleAttempts) {
            if runtime.isOnScreen(target.pid) {
                runtime.parked.release(pid: target.pid)
                return .recovered
            }
            if attempt < runtime.settleAttempts {
                try Task.checkCancellation()
                try await runtime.pause()
            }
        }
        if let windowID {
            runtime.parked.park(target, windowID: windowID)
        }
        return .restoredOffScreen
    }

    private static func validateIdentity(
        _ target: ProvenProcessTarget,
        runtime: Runtime
    ) throws {
        guard runtime.currentIdentity(target.pid) == target.identity else {
            throw CUError(
                "stale_process",
                "The target process changed while restoring its window. No state snapshot was published."
            )
        }
    }

    private static func nativeWindow(_ element: AXUIElement) -> NativeWindow {
        NativeWindow(
            id: { WindowGeometry.axWindowID(of: element) },
            isMinimized: { minimizedValue(element) },
            setMinimized: { minimized in
                AXUIElementSetAttributeValue(
                    element,
                    kAXMinimizedAttribute as CFString,
                    minimized ? kCFBooleanTrue : kCFBooleanFalse
                ) == .success
            },
            makeMain: {
                AXUIElementSetAttributeValue(
                    element,
                    kAXMainAttribute as CFString,
                    kCFBooleanTrue
                ) == .success
            }
        )
    }

    /// An app that says the attribute has no value has no such window; a
    /// timeout or an unreachable app says nothing about its windows.
    static func answered(_ error: AXError) -> Bool {
        error == .success || error == .noValue || error == .attributeUnsupported
    }

    /// AXWindows lists only windows on the Spaces being shown — it was empty
    /// for an Electron app whose window sat behind the user's fullscreen app —
    /// while AXMainWindow and AXFocusedWindow still name that window.
    static func mergedWindows<Element>(
        listed: [Element],
        main: Element?,
        focused: Element?,
        same: (Element, Element) -> Bool
    ) -> [Element] {
        var windows = listed
        for window in [main, focused].compactMap({ $0 }) where !windows.contains(where: { same($0, window) }) {
            windows.append(window)
        }
        return windows
    }

    private static func windowElements(_ app: AXUIElement) -> [AXUIElement]? {
        var listedValue: CFTypeRef?
        guard answered(AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &listedValue)) else {
            return nil
        }
        var single: [AXUIElement?] = []
        for attribute in [kAXMainWindowAttribute, kAXFocusedWindowAttribute] {
            var value: CFTypeRef?
            guard answered(AXUIElementCopyAttributeValue(app, attribute as CFString, &value)) else {
                return nil
            }
            single.append(value.flatMap {
                CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil
            })
        }
        return mergedWindows(
            listed: listedValue as? [AXUIElement] ?? [],
            main: single[0],
            focused: single[1],
            same: { CFEqual($0, $1) }
        )
    }

    static func minimizedValue(_ window: AXUIElement) -> Bool? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            window,
            kAXMinimizedAttribute as CFString,
            &raw
        ) == .success,
        let raw,
        CFGetTypeID(raw) == CFBooleanGetTypeID() else { return nil }
        return CFBooleanGetValue((raw as! CFBoolean))
    }

    /// Hands the foreground back if the app answered a restore by activating
    /// itself. Best effort: a read never fails because the guard could not
    /// start, and a user who moved meanwhile keeps what they chose.
    static func foregroundGuard(
        runtime: ForegroundLeaseRuntime
    ) -> (ProvenProcessTarget) -> @MainActor () async -> Void {
        { target in
            let lease = try? ForegroundLease.acquire(target: target, runtime: runtime)
            return { try? await lease?.finalize() }
        }
    }
}
