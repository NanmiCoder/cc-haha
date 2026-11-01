import AppKit
import os
import XCTest

@testable import cc_haha_computer_use

/// Only the OS observations and event transport are substituted. Each test
/// drives the production coordinator and, where relevant, the real observer.
@MainActor
final class FocusLifecycleIntegrationTests: XCTestCase {
    private let targetPID: pid_t = 42

    func testClickTypeAndReturnShareOneAcceptedFocusEstablishment() async throws {
        let coordinator = SyntheticWindowFocus.Coordinator()
        let external = FocusExternalRuntime()
        for action in ["click", "type_text", "Return"] {
            try await coordinator.prepare(pid: targetPID, window: nil, runtime: external.runtime())
            external.recordAction(action)
        }
        XCTAssertEqual(external.snapshot.posts, ["activate"])
        XCTAssertEqual(external.snapshot.actions, ["click", "type_text", "Return"])
    }

    func testLostFocusAfterSuccessIsRestoredBeforeTheNextAction() async throws {
        let coordinator = SyntheticWindowFocus.Coordinator()
        let external = FocusExternalRuntime()
        try await coordinator.prepare(pid: targetPID, window: nil, runtime: external.runtime())
        external.recordAction("click")
        external.update { $0.hasFocus = false; $0.acceptsInput = false }
        coordinator.observeFocus(pid: targetPID, hasFocus: false)

        for action in ["type_text", "Return"] {
            try await coordinator.prepare(pid: targetPID, window: nil, runtime: external.runtime())
            external.recordAction(action)
        }
        XCTAssertEqual(external.snapshot.posts, ["activate", "returnFocus"])
        XCTAssertEqual(external.snapshot.actions, ["click", "type_text", "Return"])
    }

    func testAnAlreadyFocusedApplicationReceivesNoEstablishment() async throws {
        for active in [false, true] {
            let coordinator = SyntheticWindowFocus.Coordinator()
            let external = FocusExternalRuntime()
            external.update { $0.isActive = active; $0.hasFocus = true; $0.acceptsInput = true }
            try await coordinator.prepare(pid: targetPID, window: nil, runtime: external.runtime())
            XCTAssertTrue(external.snapshot.posts.isEmpty)
        }
    }

    func testAnActiveApplicationWithoutFocusNeedsOnlyFocusReturned() async throws {
        let coordinator = SyntheticWindowFocus.Coordinator()
        let external = FocusExternalRuntime()
        external.update { $0.isActive = true }
        try await coordinator.prepare(pid: targetPID, window: nil, runtime: external.runtime())
        XCTAssertEqual(external.snapshot.posts, ["returnFocus"])
    }

    func testRealActivationThenCoverWithoutAnIntermediateCURequestReestablishesInput() async throws {
        let coordinator = SyntheticWindowFocus.Coordinator()
        let external = FocusExternalRuntime()
        let center = NotificationCenter()
        let observer = SyntheticWindowFocus.ApplicationLifecycleObserver(center: center, coordinator: coordinator)
        defer { withExtendedLifetime(observer) {} }
        let application = FocusNotificationApplication()
        let pid = application.processIdentifier
        try await coordinator.prepare(pid: pid, window: nil, runtime: external.runtime())

        external.update { $0.isActive = true }
        center.post(name: NSWorkspace.didActivateApplicationNotification, object: nil,
                    userInfo: [NSWorkspace.applicationUserInfoKey: application])
        external.update { $0.isActive = false; $0.hasFocus = false; $0.acceptsInput = false }
        center.post(name: NSWorkspace.didDeactivateApplicationNotification, object: nil,
                    userInfo: [NSWorkspace.applicationUserInfoKey: application])

        try await coordinator.prepare(pid: pid, window: nil, runtime: external.runtime())
        external.recordAction("search-after-cover")
        XCTAssertEqual(external.snapshot.posts, ["activate", "activate"])
        XCTAssertEqual(external.snapshot.actions, ["search-after-cover"])
    }

    func testLateActivationNotificationIsNotDroppedBecauseTheTargetIsAlreadyCovered() async throws {
        let coordinator = SyntheticWindowFocus.Coordinator()
        let external = FocusExternalRuntime()
        let center = NotificationCenter()
        let observer = SyntheticWindowFocus.ApplicationLifecycleObserver(center: center, coordinator: coordinator)
        defer { withExtendedLifetime(observer) {} }
        let application = FocusNotificationApplication()
        let pid = application.processIdentifier
        try await coordinator.prepare(pid: pid, window: nil, runtime: external.runtime())

        // Activation arrives after the target is already covered. The next
        // request observes deactivation even if its notification is still
        // queued; dropping this activation would lose the entire transition.
        external.update { $0.isActive = false; $0.hasFocus = false; $0.acceptsInput = false }
        center.post(name: NSWorkspace.didActivateApplicationNotification, object: nil,
                    userInfo: [NSWorkspace.applicationUserInfoKey: application])

        try await coordinator.prepare(pid: pid, window: nil, runtime: external.runtime())
        XCTAssertEqual(external.snapshot.posts, ["activate", "activate"])
    }

    func testUnrelatedAndMalformedLifecycleNotificationsDoNotResetAcceptedFocus() async throws {
        let coordinator = SyntheticWindowFocus.Coordinator()
        let external = FocusExternalRuntime()
        let center = NotificationCenter()
        let observer = SyntheticWindowFocus.ApplicationLifecycleObserver(center: center, coordinator: coordinator)
        defer { withExtendedLifetime(observer) {} }
        try await coordinator.prepare(pid: targetPID, window: nil, runtime: external.runtime())

        center.post(name: NSWorkspace.didActivateApplicationNotification, object: nil,
                    userInfo: [NSWorkspace.applicationUserInfoKey: "not an application"])
        let unrelatedApplication = FocusNotificationApplication(pid: 43)
        center.post(name: NSWorkspace.didDeactivateApplicationNotification, object: nil,
                    userInfo: [NSWorkspace.applicationUserInfoKey: unrelatedApplication])

        try await coordinator.prepare(pid: targetPID, window: nil, runtime: external.runtime())
        XCTAssertEqual(external.snapshot.posts, ["activate"])
    }

    func testTimeoutCannotAuthorizeAnActionAndTheNextAttemptCanRecover() async throws {
        let coordinator = SyntheticWindowFocus.Coordinator()
        let external = FocusExternalRuntime()
        external.update { $0.acceptOnPost = false }
        do {
            try await coordinator.prepare(pid: targetPID, window: nil, runtime: external.runtime())
            external.recordAction("must-not-run")
            XCTFail("unacknowledged activation must not authorize input")
        } catch let error as CUError {
            XCTAssertEqual(error.code, "focus_not_accepted")
        }
        XCTAssertTrue(external.snapshot.actions.isEmpty)
        XCTAssertEqual(external.snapshot.posts, ["activate"])

        external.update { $0.acceptOnPost = true }
        try await coordinator.prepare(pid: targetPID, window: nil, runtime: external.runtime())
        external.recordAction("recovered")
        XCTAssertEqual(external.snapshot.posts, ["activate", "activate"])
        XCTAssertEqual(external.snapshot.actions, ["recovered"])
    }

    /// Minimizing and restoring a Chromium window dropped its synthetic
    /// activation without any focus notification. The cached belief is stale,
    /// so it is established again in the same request instead of failing it.
    func testCachedFocusTheTargetContradictsIsEstablishedAgain() async throws {
        let coordinator = SyntheticWindowFocus.Coordinator()
        let external = FocusExternalRuntime()
        try await coordinator.prepare(pid: targetPID, window: nil, runtime: external.runtime())
        external.update { $0.acceptsInput = false }

        try await coordinator.prepare(pid: targetPID, window: nil, runtime: external.runtime())
        external.recordAction("click")

        XCTAssertEqual(external.snapshot.posts, ["activate", "activate"])
        XCTAssertEqual(external.snapshot.actions, ["click"])
    }

    /// A timeout says nothing about the target's activation, so it must not
    /// post a fresh activation (and its activation click).
    func testATimedOutReadNeverTriggersAFreshActivation() async throws {
        let coordinator = SyntheticWindowFocus.Coordinator()
        let external = FocusExternalRuntime()
        try await coordinator.prepare(pid: targetPID, window: nil, runtime: external.runtime())
        external.update { $0.acceptsInput = false; $0.axAnswers = false }
        do {
            try await coordinator.prepare(pid: targetPID, window: nil, runtime: external.runtime())
            external.recordAction("must-not-run")
            XCTFail("an unanswered read is not an acknowledgement")
        } catch let error as CUError {
            XCTAssertEqual(error.code, "focus_not_accepted")
        }
        XCTAssertEqual(external.snapshot.posts, ["activate"])
        XCTAssertTrue(external.snapshot.actions.isEmpty)
    }

    /// A hidden app with focus cached dropped a click and stayed hidden. The
    /// full activation is what shows it again, without taking the foreground.
    func testAHiddenAppIsActivatedAgainWhateverTheCacheSays() async throws {
        let coordinator = SyntheticWindowFocus.Coordinator()
        let external = FocusExternalRuntime()
        try await coordinator.prepare(pid: targetPID, window: nil, runtime: external.runtime())
        external.update { $0.isHidden = true }
        try await coordinator.prepare(pid: targetPID, window: nil, runtime: external.runtime())
        external.recordAction("click")
        XCTAssertEqual(external.snapshot.posts, ["activate", "activate"])
        XCTAssertEqual(external.snapshot.actions, ["click"])
    }

    /// The activation click would land in the window the user is working in.
    func testTheUsersRealFrontmostAppIsNeverReactivated() async throws {
        let coordinator = SyntheticWindowFocus.Coordinator()
        let external = FocusExternalRuntime()
        external.update { $0.isActive = true; $0.hasFocus = true; $0.acceptsInput = true }
        try await coordinator.prepare(pid: targetPID, window: nil, runtime: external.runtime())
        external.update { $0.acceptsInput = false }
        do {
            try await coordinator.prepare(pid: targetPID, window: nil, runtime: external.runtime())
            XCTFail("a frontmost app that does not acknowledge must not receive input")
        } catch let error as CUError {
            XCTAssertEqual(error.code, "focus_not_accepted")
        }
        XCTAssertTrue(external.snapshot.posts.isEmpty)
    }

    func testCachedFocusStillRequiresTheTargetToAcceptInput() async throws {
        let coordinator = SyntheticWindowFocus.Coordinator()
        let external = FocusExternalRuntime()
        try await coordinator.prepare(pid: targetPID, window: nil, runtime: external.runtime())
        external.update { $0.acceptsInput = false; $0.acceptOnPost = false }
        do {
            try await coordinator.prepare(pid: targetPID, window: nil, runtime: external.runtime())
            external.recordAction("must-not-run")
            XCTFail("a cached belief is not an AXFrontmost acknowledgement")
        } catch let error as CUError {
            XCTAssertEqual(error.code, "focus_not_accepted")
        }
        XCTAssertTrue(external.snapshot.actions.isEmpty)
        XCTAssertEqual(external.snapshot.posts, ["activate", "activate"])
    }

    func testFailedEventConstructionDoesNotCommitBeliefAndCanRetry() async throws {
        let coordinator = SyntheticWindowFocus.Coordinator()
        let external = FocusExternalRuntime()
        external.update { $0.postSucceeds = false }
        do {
            try await coordinator.prepare(pid: targetPID, window: nil, runtime: external.runtime())
            external.recordAction("must-not-run")
            XCTFail("a failed activation must not authorize input")
        } catch {}
        XCTAssertTrue(external.snapshot.actions.isEmpty)

        external.update { $0.postSucceeds = true }
        try await coordinator.prepare(pid: targetPID, window: nil, runtime: external.runtime())
        XCTAssertEqual(external.snapshot.posts, ["activate", "activate"])
    }

    func testProcessReplacementDuringAcceptanceWaitCannotInheritFocus() async throws {
        let coordinator = SyntheticWindowFocus.Coordinator()
        let external = FocusExternalRuntime()
        external.update { $0.acceptOnPost = false }
        let runtime = external.runtime(onPause: {
            external.update {
                $0.identity = FocusExternalRuntime.identity(launchTime: 2)
                $0.hasFocus = true
                $0.acceptsInput = true
            }
        })
        do {
            try await coordinator.prepare(pid: targetPID, window: nil, runtime: runtime)
            external.recordAction("must-not-run")
            XCTFail("the new process must not inherit an in-flight activation")
        } catch let error as CUError {
            XCTAssertEqual(error.code, "stale_process")
        }
        XCTAssertTrue(external.snapshot.actions.isEmpty)
    }

    func testAPIDReusedBetweenRequestsEstablishesFocusForTheNewLifetime() async throws {
        let coordinator = SyntheticWindowFocus.Coordinator()
        let external = FocusExternalRuntime()
        try await coordinator.prepare(pid: targetPID, window: nil, runtime: external.runtime())
        external.update {
            $0.identity = FocusExternalRuntime.identity(launchTime: 2)
            $0.hasFocus = false
            $0.acceptsInput = false
        }
        try await coordinator.prepare(pid: targetPID, window: nil, runtime: external.runtime())
        XCTAssertEqual(external.snapshot.posts, ["activate", "activate"])
    }

    func testAConfirmationNotificationDuringTheWaitDoesNotInvalidateAcceptance() async throws {
        let coordinator = SyntheticWindowFocus.Coordinator()
        let external = FocusExternalRuntime()
        external.update { $0.acceptOnPost = false }
        let pid = targetPID
        let runtime = external.runtime(onPause: {
            coordinator.observeFocus(pid: pid, hasFocus: true)
            external.update { $0.hasFocus = true; $0.acceptsInput = true }
        })
        try await coordinator.prepare(pid: pid, window: nil, runtime: runtime)
        external.recordAction("accepted")
        try await coordinator.prepare(pid: pid, window: nil, runtime: external.runtime())
        XCTAssertEqual(external.snapshot.posts, ["activate"])
        XCTAssertEqual(external.snapshot.actions, ["accepted"])
    }

    func testFocusLossDuringRecoveryRejectsALateAcceptanceAndAllowsRetry() async throws {
        let coordinator = SyntheticWindowFocus.Coordinator()
        let external = FocusExternalRuntime()
        try await coordinator.prepare(pid: targetPID, window: nil, runtime: external.runtime())
        external.update { $0.hasFocus = false; $0.acceptsInput = false; $0.acceptOnPost = false }
        coordinator.observeFocus(pid: targetPID, hasFocus: false)
        let pid = targetPID
        let runtime = external.runtime(onPause: {
            coordinator.observeFocus(pid: pid, hasFocus: false)
            external.update { $0.hasFocus = true; $0.acceptsInput = true }
        })
        do {
            try await coordinator.prepare(pid: pid, window: nil, runtime: runtime)
            external.recordAction("must-not-run")
            XCTFail("a later focus loss must invalidate the activation receipt")
        } catch let error as CUError {
            XCTAssertEqual(error.code, "focus_changed")
        }
        XCTAssertTrue(external.snapshot.actions.isEmpty)

        external.update { $0.hasFocus = false; $0.acceptsInput = false; $0.acceptOnPost = true }
        try await coordinator.prepare(pid: pid, window: nil, runtime: external.runtime())
        external.recordAction("retry")
        XCTAssertEqual(external.snapshot.actions, ["retry"])
        XCTAssertEqual(external.snapshot.posts.count, 3)
    }

    func testSessionDrainRequiresANewEstablishment() async throws {
        let coordinator = SyntheticWindowFocus.Coordinator()
        let external = FocusExternalRuntime()
        try await coordinator.prepare(pid: targetPID, window: nil, runtime: external.runtime())
        _ = coordinator.drain()
        external.update { $0.hasFocus = false; $0.acceptsInput = false }
        try await coordinator.prepare(pid: targetPID, window: nil, runtime: external.runtime())
        XCTAssertEqual(external.snapshot.posts, ["activate", "activate"])
    }

    func testLostMonitorAfterRegistrationBeforeBeliefCreationCannotAuthorizeInput() async throws {
        let coordinator = SyntheticWindowFocus.Coordinator()
        let external = FocusExternalRuntime()
        let stream = FocusLifecycleStream()
        let monitor = try registeredMonitor(stream: stream, coordinator: coordinator)
        let runtime = protectedRuntime(external: external, monitor: monitor)
        stream.interrupt()
        external.update { $0.acceptsInput = true }

        do {
            try await coordinator.prepare(pid: targetPID, window: nil, runtime: runtime)
            external.recordAction("must-not-run")
            XCTFail("lost observation cannot be replaced by a stale AXFrontmost value")
        } catch let error as CUError {
            XCTAssertEqual(error.code, "focus_monitor_interrupted")
        }
        XCTAssertTrue(external.snapshot.posts.isEmpty)
        XCTAssertTrue(external.snapshot.actions.isEmpty)
    }

    func testMonitorLossWhileReadingInitialIdentityCannotPostActivation() async throws {
        let coordinator = SyntheticWindowFocus.Coordinator()
        let external = FocusExternalRuntime()
        let stream = FocusLifecycleStream()
        let monitor = try registeredMonitor(stream: stream, coordinator: coordinator)
        var runtime = protectedRuntime(external: external, monitor: monitor)
        runtime.identity = { _ in
            stream.interrupt()
            return external.snapshot.identity
        }

        do {
            try await coordinator.prepare(pid: targetPID, window: nil, runtime: runtime)
            XCTFail("the pre-post continuity check must catch loss after the entry check")
        } catch let error as CUError {
            XCTAssertEqual(error.code, "focus_monitor_interrupted")
        }
        XCTAssertTrue(external.snapshot.posts.isEmpty)
    }

    func testMonitorLossDuringTheWaitWithholdsInputEvenIfAXAcknowledges() async throws {
        let coordinator = SyntheticWindowFocus.Coordinator()
        let external = FocusExternalRuntime()
        let stream = FocusLifecycleStream()
        let monitor = try registeredMonitor(stream: stream, coordinator: coordinator)
        var runtime = protectedRuntime(external: external, monitor: monitor)
        runtime.pause = {
            stream.interrupt()
            external.update { $0.acceptsInput = true }
        }

        do {
            try await coordinator.prepare(pid: targetPID, window: nil, runtime: runtime)
            external.recordAction("must-not-run")
            XCTFail("an acknowledgement after monitor loss is not safe to act on")
        } catch let error as CUError {
            XCTAssertEqual(error.code, "focus_monitor_interrupted")
        }
        XCTAssertEqual(external.snapshot.posts, ["activate"])
        XCTAssertTrue(external.snapshot.actions.isEmpty)
    }

    func testMonitorLossDuringAcknowledgementCannotCommitTheReceipt() async throws {
        let coordinator = SyntheticWindowFocus.Coordinator()
        let external = FocusExternalRuntime()
        let stream = FocusLifecycleStream()
        let monitor = try registeredMonitor(stream: stream, coordinator: coordinator)
        var runtime = protectedRuntime(external: external, monitor: monitor)
        runtime.acceptsInput = { _ in
            stream.interrupt()
            return true
        }

        do {
            try await coordinator.prepare(pid: targetPID, window: nil, runtime: runtime)
            external.recordAction("must-not-run")
            XCTFail("the receipt needs a final continuity check after reading AX")
        } catch let error as CUError {
            XCTAssertEqual(error.code, "focus_monitor_interrupted")
        }
        XCTAssertTrue(external.snapshot.actions.isEmpty)
    }

    func testAlreadyCancelledPreparationNeverPostsFocusEvents() async throws {
        let coordinator = SyntheticWindowFocus.Coordinator()
        let external = FocusExternalRuntime()
        let pid = targetPID
        let task = Task { @MainActor in
            withUnsafeCurrentTask { $0?.cancel() }
            try await coordinator.prepare(pid: pid, window: nil, runtime: external.runtime())
            external.recordAction("must-not-run")
        }
        do {
            try await task.value
            XCTFail("cancelled preparation must not post activation")
        } catch is CancellationError {}
        XCTAssertTrue(external.snapshot.posts.isEmpty)
        XCTAssertTrue(external.snapshot.actions.isEmpty)
    }

    func testDetachedCallerRunsAllOSObservationAndPostingCallbacksOnMainActor() async throws {
        let coordinator = SyntheticWindowFocus.Coordinator()
        let calls = OSAllocatedUnfairLock(initialState: Set<String>())
        let runtime = SyntheticWindowFocus.Runtime(
            identity: { _ in
                MainActor.assertIsolated()
                calls.withLock { _ = $0.insert("identity") }
                return FocusExternalRuntime.identity(launchTime: 1)
            },
            isActive: { _ in
                MainActor.assertIsolated()
                calls.withLock { _ = $0.insert("isActive") }
                return false
            },
            hasFocus: { _ in
                MainActor.assertIsolated()
                calls.withLock { _ = $0.insert("hasFocus") }
                return false
            },
            acceptsInput: { _ in
                MainActor.assertIsolated()
                calls.withLock { _ = $0.insert("acceptsInput") }
                return true
            },
            post: { _, _, _ in
                MainActor.assertIsolated()
                calls.withLock { _ = $0.insert("post") }
                return true
            },
            pause: { await Task.yield() },
            validateContinuity: {
                MainActor.assertIsolated()
                calls.withLock { _ = $0.insert("continuity") }
            }
        )
        let pid = targetPID
        try await Task.detached {
            try await coordinator.prepare(pid: pid, window: nil, runtime: runtime)
        }.value
        XCTAssertEqual(calls.withLock { $0 }, ["identity", "isActive", "hasFocus", "acceptsInput", "post", "continuity"])
    }

    private func registeredMonitor(
        stream: FocusLifecycleStream,
        coordinator: SyntheticWindowFocus.Coordinator
    ) throws -> FocusEventMonitor {
        let monitor = FocusEventMonitor(
            helperPID: 700, readInitialFocus: { 9 }, isFocusObserver: { _ in false },
            makeStream: { stream }, releaseFocus: { _ in true },
            readRealFrontmost: { 9 }, isOrdinaryApp: { _ in true },
            readProcessIdentity: { .init(executablePath: "/test/\($0)", launchTime: 1) }
        )
        let pid = targetPID
        XCTAssertTrue(monitor.register(pid: pid) { coordinator.observeFocus(pid: pid, hasFocus: $0) })
        return monitor
    }

    private func protectedRuntime(
        external: FocusExternalRuntime, monitor: FocusEventMonitor
    ) -> SyntheticWindowFocus.Runtime {
        let continuity = monitor.diagnostic.continuityGeneration
        var runtime = external.runtime()
        runtime.validateContinuity = {
            let diagnostic = monitor.diagnostic
            guard diagnostic.available, diagnostic.continuityGeneration == continuity else {
                throw CUError("focus_monitor_interrupted", "Focus observation was interrupted")
            }
        }
        return runtime
    }
}

private final class FocusLifecycleStream: FocusEventMonitor.Stream, @unchecked Sendable {
    private let interruption = OSAllocatedUnfairLock<(@Sendable (String) -> Void)?>(initialState: nil)

    func start(
        receive: @escaping @Sendable (FocusEventMonitor.Event) -> FocusEventMonitor.Disposition,
        interrupted: @escaping @Sendable (String) -> Void
    ) -> Bool {
        interruption.withLock { $0 = interrupted }
        return true
    }

    func addProtectedPID(_ pid: pid_t) -> Bool { true }
    func stop() {}
    func interrupt() { interruption.withLock { $0 }?("test_interruption") }
}

/// Command-line XCTest is not necessarily a LaunchServices application, so
/// NSRunningApplication.current can report -1. Keep the real payload type and
/// production observer without registering a GUI application during a test.
private final class FocusNotificationApplication: NSRunningApplication, @unchecked Sendable {
    let fixturePID: pid_t

    init(pid: pid_t = 42) {
        fixturePID = pid
        super.init()
    }

    override var processIdentifier: pid_t { fixturePID }
}

private final class FocusExternalRuntime: @unchecked Sendable {
    struct Snapshot: Sendable {
        var identity: AXTreeProcessIdentity? = FocusExternalRuntime.identity(launchTime: 1)
        var isActive = false
        var hasFocus = false
        var acceptsInput = false
        /// False models an AX timeout: no answer about AXFrontmost at all.
        var axAnswers = true
        var isHidden = false
        var acceptOnPost = true
        var postSucceeds = true
        var posts: [String] = []
        var actions: [String] = []
    }

    private let state = OSAllocatedUnfairLock(initialState: Snapshot())
    var snapshot: Snapshot { state.withLock { $0 } }

    static func identity(launchTime: TimeInterval) -> AXTreeProcessIdentity {
        AXTreeProcessIdentity(
            bundleID: "com.example.focus-target",
            executablePath: "/Applications/FocusTarget.app/Contents/MacOS/FocusTarget",
            launchTime: launchTime
        )
    }

    func update(_ mutation: @Sendable (inout Snapshot) -> Void) { state.withLock(mutation) }
    func recordAction(_ action: String) { state.withLock { $0.actions.append(action) } }

    func runtime(
        attempts: Int = 3,
        onPause: @escaping @Sendable () async throws -> Void = {}
    ) -> SyntheticWindowFocus.Runtime {
        SyntheticWindowFocus.Runtime(
            identity: { [self] _ in snapshot.identity },
            isActive: { [self] _ in snapshot.isActive },
            hasFocus: { [self] _ in snapshot.hasFocus },
            acceptsInput: { [self] _ in snapshot.acceptsInput },
            deniesActivation: { [self] _ in snapshot.axAnswers && !snapshot.acceptsInput },
            isHidden: { [self] _ in snapshot.isHidden },
            post: { [self] establishment, _, _ in
                state.withLock { state in
                    switch establishment {
                    case .activate: state.posts.append("activate")
                    case .returnFocus: state.posts.append("returnFocus")
                    case .none: state.posts.append("none")
                    }
                    guard state.postSucceeds else { return false }
                    if state.acceptOnPost { state.hasFocus = true; state.acceptsInput = true }
                    return true
                }
            },
            pause: onPause,
            attempts: attempts
        )
    }
}
