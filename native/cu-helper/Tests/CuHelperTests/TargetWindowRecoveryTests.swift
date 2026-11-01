import AppKit
import XCTest

@testable import cc_haha_computer_use

/// Drives `Runtime.live` — the wiring `get_app_state` uses — through fake AX
/// and window-server answers, so reverting any part of that wiring fails here.
@MainActor
final class TargetWindowRecoveryTests: XCTestCase {
    private let pid: pid_t = 72_041
    private let identity = AXTreeProcessIdentity(
        bundleID: "com.apple.TextEdit",
        executablePath: "/System/Applications/TextEdit.app/Contents/MacOS/TextEdit",
        launchTime: 44
    )

    // MARK: - What counts as actionable

    func testAWindowOffTheShownSpacesIsActionableUnlessMinimized() {
        // Another Space, or a hidden app: AX still reports a non-minimized
        // window, and input reaches it.
        XCTAssertEqual(TargetWindowRecovery.actionability(onScreen: false, windowMinimizedStates: [false]), .actionable)
        XCTAssertEqual(TargetWindowRecovery.actionability(onScreen: false, windowMinimizedStates: [true, nil]), .actionable)
        XCTAssertEqual(TargetWindowRecovery.actionability(onScreen: false, windowMinimizedStates: [true, true]), .notActionable)
        XCTAssertEqual(TargetWindowRecovery.actionability(onScreen: false, windowMinimizedStates: []), .notActionable)
        XCTAssertEqual(TargetWindowRecovery.actionability(onScreen: true, windowMinimizedStates: []), .actionable)
    }

    func testNoAnswerFromAccessibilityIsNotANo() {
        XCTAssertEqual(TargetWindowRecovery.actionability(onScreen: false, windowMinimizedStates: nil), .unknown)
        XCTAssertTrue(TargetWindowRecovery.answered(.success))
        XCTAssertTrue(TargetWindowRecovery.answered(.noValue))
        XCTAssertTrue(TargetWindowRecovery.answered(.attributeUnsupported))
        XCTAssertFalse(TargetWindowRecovery.answered(.cannotComplete))
        XCTAssertFalse(TargetWindowRecovery.answered(.apiDisabled))
    }

    func testMainAndFocusedWindowsFillInWhatAXWindowsMisses() {
        // AXWindows listed nothing for an Electron window behind the user's
        // fullscreen app; AXMainWindow still named it.
        XCTAssertEqual(
            TargetWindowRecovery.mergedWindows(listed: [String](), main: "behind", focused: "behind", same: ==),
            ["behind"]
        )
        XCTAssertEqual(
            TargetWindowRecovery.mergedWindows(listed: ["a"], main: "b", focused: "a", same: ==),
            ["a", "b"]
        )
    }

    // MARK: - get_app_state's live runtime

    /// The reported failure: once the user switched to our fullscreen window,
    /// every read activated the target and dragged them back to its Space.
    func testTargetOnAnotherSpaceIsReadWhereItIs() async throws {
        let app = FakeApp(identity: identity, windows: [FakeWindow(id: 9, minimized: false)])
        app.onScreen = true
        let runtime = app.runtime(pid: pid)
        let onScreen = try await TargetWindowRecovery.recoverIfNeeded(target: try target(), runtime: runtime)
        XCTAssertEqual(onScreen, .alreadyActionable)

        app.onScreen = false
        for _ in 0..<3 {
            let later = try await TargetWindowRecovery.recoverIfNeeded(target: try target(), runtime: runtime)
            XCTAssertEqual(later, .alreadyActionable)
        }
        XCTAssertEqual(app.events, [], "nothing may be restored, reopened, or guarded")
    }

    func testHiddenAppIsReadAsItIs() async throws {
        // Hidden apps keep reporting their windows to AX, and an action shows
        // them again; a read must not.
        let app = FakeApp(identity: identity, windows: [FakeWindow(id: 9, minimized: false)])
        let outcome = try await TargetWindowRecovery.recoverIfNeeded(target: try target(), runtime: app.runtime(pid: pid))
        XCTAssertEqual(outcome, .alreadyActionable)
        XCTAssertEqual(app.events, [])
    }

    func testUnansweredAccessibilityChangesNothing() async throws {
        let app = FakeApp(identity: identity, windows: [FakeWindow(id: 9, minimized: true)])
        app.answers = false
        let outcome = try await TargetWindowRecovery.recoverIfNeeded(target: try target(), runtime: app.runtime(pid: pid))
        XCTAssertEqual(outcome, .unknown)
        XCTAssertEqual(app.events, [], "a timeout is not a reason to reopen or restore")
    }

    func testMinimizedWindowIsRestoredInTheBackgroundAndMadeMain() async throws {
        let app = FakeApp(identity: identity, windows: [FakeWindow(id: 9, minimized: true)])
        app.restoreShowsOnScreen = true
        let outcome = try await TargetWindowRecovery.recoverIfNeeded(target: try target(), runtime: app.runtime(pid: pid))

        XCTAssertEqual(outcome, .recovered)
        XCTAssertEqual(app.events, ["guard", "unminimize 9", "main 9", "release"])
        XCTAssertFalse(app.parked.isParked(pid: pid, identity: identity, windowID: 9))
    }

    /// Restored while the user sat in a fullscreen Space, the window refused
    /// input until that Space was shown. It must be refused, not "delivered".
    func testWindowRestoredOntoAHiddenSpaceIsParkedUntilShown() async throws {
        let app = FakeApp(identity: identity, windows: [FakeWindow(id: 9, minimized: true)])
        let runtime = app.runtime(pid: pid)

        let outcome = try await TargetWindowRecovery.recoverIfNeeded(target: try target(), runtime: runtime)
        XCTAssertEqual(outcome, .restoredOffScreen)
        XCTAssertEqual(
            TargetWindowRecovery.windowState(pid: pid, windowID: 9, native: app.native(), parked: app.parked),
            .parked
        )

        app.onScreen = true
        _ = try await TargetWindowRecovery.recoverIfNeeded(target: try target(), runtime: runtime)
        XCTAssertEqual(
            TargetWindowRecovery.windowState(pid: pid, windowID: 9, native: app.native(), parked: app.parked),
            .takesInput
        )
    }

    func testWindowStateNamesWhatBlocksInput() {
        let app = FakeApp(identity: identity, windows: [FakeWindow(id: 9, minimized: true), FakeWindow(id: 10, minimized: false)])
        XCTAssertEqual(TargetWindowRecovery.windowState(pid: pid, windowID: 9, native: app.native(), parked: app.parked), .minimized)
        XCTAssertEqual(TargetWindowRecovery.windowState(pid: pid, windowID: 10, native: app.native(), parked: app.parked), .takesInput)
        XCTAssertEqual(TargetWindowRecovery.windowState(pid: pid, windowID: 11, native: app.native(), parked: app.parked), .gone)
        app.answers = false
        XCTAssertEqual(TargetWindowRecovery.windowState(pid: pid, windowID: 10, native: app.native(), parked: app.parked), .unknown)
    }

    func testOnlyAnAppThatSaysItHasNoWindowIsReopened() async throws {
        let app = FakeApp(identity: identity, windows: [])
        app.reopenAdds = FakeWindow(id: 12, minimized: false)
        let outcome = try await TargetWindowRecovery.recoverIfNeeded(target: try target(), runtime: app.runtime(pid: pid))
        XCTAssertEqual(outcome, .recovered)
        XCTAssertEqual(app.events, ["guard", "reopen", "release"])
    }

    func testRecoveryStopsAsSoonAsTheAppStopsAnswering() async throws {
        let app = FakeApp(identity: identity, windows: [FakeWindow(id: 9, minimized: true)])
        app.stopAnsweringAfterRequest = true
        do {
            _ = try await TargetWindowRecovery.recoverIfNeeded(target: try target(), runtime: app.runtime(pid: pid))
            XCTFail("an app that stopped answering cannot be confirmed restored")
        } catch let error as CUError {
            XCTAssertEqual(error.code, "target_window_offscreen")
            XCTAssertTrue(error.message.contains("stopped answering"))
        }
        XCTAssertEqual(app.pauses, 0, "no polling against an app that does not answer")
        XCTAssertEqual(app.events.last, "release")
    }

    func testAcceptedRestoreThatNeverProducesAWindowFailsClosed() async throws {
        let app = FakeApp(identity: identity, windows: [FakeWindow(id: 9, minimized: true)])
        app.unminimizeSticks = false
        do {
            _ = try await TargetWindowRecovery.recoverIfNeeded(target: try target(), runtime: app.runtime(pid: pid, attempts: 2))
            XCTFail("an accepted request is not proof that a window became available")
        } catch let error as CUError {
            XCTAssertEqual(error.code, "target_window_offscreen")
        }
        XCTAssertEqual(app.pauses, 2)
    }

    func testPIDReuseIsRejectedBeforeAnyNativeWindowMutation() {
        let replacement = AXTreeProcessIdentity(
            bundleID: identity.bundleID,
            executablePath: identity.executablePath,
            launchTime: 45
        )
        let app = FakeApp(identity: replacement, windows: [FakeWindow(id: 9, minimized: true)])
        XCTAssertEqual(TargetWindowRecovery.requestNativeRecovery(target: try! target(), runtime: app.native()), .refused)
        XCTAssertEqual(app.events, [])
    }

    func testProcessReplacementDuringRecoveryCannotInheritSuccess() async throws {
        let app = FakeApp(identity: identity, windows: [FakeWindow(id: 9, minimized: true)])
        app.restoreShowsOnScreen = true
        var runtime = app.runtime(pid: pid)
        let replacement = AXTreeProcessIdentity(
            bundleID: identity.bundleID, executablePath: identity.executablePath, launchTime: 45
        )
        runtime.currentIdentity = { [app] _ in app.events.contains("unminimize 9") ? replacement : app.identity }
        do {
            _ = try await TargetWindowRecovery.recoverIfNeeded(target: try target(), runtime: runtime)
            XCTFail("a replacement process must not inherit the original recovery")
        } catch let error as CUError {
            XCTAssertEqual(error.code, "stale_process")
        }
    }

    // MARK: - Foreground guard

    /// An app may answer a restore by activating itself. The guard hands the
    /// foreground back to the user's app through the real ForegroundLease.
    func testForegroundGuardHandsTheForegroundBack() async throws {
        let userApp = try XCTUnwrap(ProvenProcessTarget(pid: 22, identity: AXTreeProcessIdentity(
            bundleID: "com.example.user", executablePath: "/Applications/User.app/Contents/MacOS/User", launchTime: 3
        )))
        let target = try target()
        var frontmost = userApp
        var activated: [pid_t] = []
        let leaseRuntime = ForegroundLeaseRuntime(
            inputSnapshot: { PhysicalInputEpochSnapshot(epoch: 7, available: true) },
            frontmostTarget: { frontmost },
            currentIdentity: { $0 == userApp.pid ? userApp.identity : target.identity },
            activate: { expected in
                activated.append(expected.pid)
                frontmost = expected
                return true
            },
            verifyFrontmost: { frontmost == $0 }
        )
        let app = FakeApp(identity: identity, windows: [FakeWindow(id: 9, minimized: true)])
        app.restoreShowsOnScreen = true
        app.onRestore = { frontmost = target }
        var runtime = app.runtime(pid: pid)
        runtime.guardForeground = TargetWindowRecovery.foregroundGuard(runtime: leaseRuntime)

        let outcome = try await TargetWindowRecovery.recoverIfNeeded(target: target, runtime: runtime)
        XCTAssertEqual(outcome, .recovered)
        XCTAssertEqual(activated, [userApp.pid])
        XCTAssertEqual(frontmost, userApp)
    }

    func testGetAppStateUsesTheLiveRuntimeWithTheLeaseGuard() throws {
        let body = try handleGetAppStateBody()
        let runtime = try XCTUnwrap(body.range(of: "TargetWindowRecovery.Runtime.live()"))
        let guardWiring = try XCTUnwrap(body.range(of: "TargetWindowRecovery.foregroundGuard(runtime: foregroundRuntime)"))
        let recovery = try XCTUnwrap(body.range(of: "TargetWindowRecovery.recoverIfNeeded(target: target, runtime: recovery)"))
        XCTAssertLessThan(runtime.lowerBound, guardWiring.lowerBound)
        XCTAssertLessThan(guardWiring.lowerBound, recovery.lowerBound)
    }

    func testGetAppStateJoinsRecoveryBeforePublishingANewSnapshot() throws {
        let body = try handleGetAppStateBody()
        let recovery = try XCTUnwrap(body.range(of: "TargetWindowRecovery.recoverIfNeeded"))
        let snapshot = try XCTUnwrap(body.range(of: "AXTree.appState"))
        let authorization = try XCTUnwrap(body.range(of: "authorizeResolvedTarget"))

        XCTAssertLessThan(authorization.lowerBound, recovery.lowerBound)
        XCTAssertLessThan(
            recovery.lowerBound,
            snapshot.lowerBound,
            "the explicit target must be recoverable before AX publishes window identity and geometry"
        )
    }

    // MARK: - Never foreground

    func testBackgroundReopenNeverActivatesOrSubstitutesAnotherCopy() {
        let configuration = TargetWindowRecovery.backgroundReopenConfiguration()
        XCTAssertFalse(configuration.activates)
        XCTAssertFalse(configuration.allowsRunningApplicationSubstitution)
        XCTAssertFalse(configuration.createsNewApplicationInstance)
    }

    func testReadingHasNoActivationOrUnhidePath() throws {
        for file in ["TargetWindowRecovery.swift", "AXTree.swift"] {
            let source = try String(contentsOf: sourceURL(file), encoding: .utf8)
            let code = source.split(separator: "\n").filter {
                !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//")
            }.joined(separator: "\n")
            for call in [".activate(", "activateAllWindows", "activateIgnoringOtherApps", ".unhide("] {
                XCTAssertFalse(code.contains(call), "\(file) must not call \(call)")
            }
        }
    }

    // MARK: - Helpers

    private func target() throws -> ProvenProcessTarget {
        try XCTUnwrap(ProvenProcessTarget(pid: pid, identity: identity))
    }

    private func handleGetAppStateBody() throws -> String {
        let source = try String(contentsOf: sourceURL("CommandRouter.swift"), encoding: .utf8)
        let start = try XCTUnwrap(source.range(of: "private func handleGetAppState"))
        return String(source[start.lowerBound...].prefix(8_000))
    }

    private func sourceURL(_ name: String) -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/cu-helper")
            .appendingPathComponent(name)
    }
}

/// One AX window with the AXMinimized/AXMain seams production writes.
@MainActor
private final class FakeWindow {
    let id: CGWindowID
    var minimized: Bool?

    init(id: CGWindowID, minimized: Bool?) {
        self.id = id
        self.minimized = minimized
    }
}

/// A target app as AX and the window server describe it. Every native write
/// is recorded in `events`; visibility follows from those writes only.
@MainActor
private final class FakeApp {
    var identity: AXTreeProcessIdentity
    var windows: [FakeWindow]
    var onScreen = false
    var answers = true
    var restoreShowsOnScreen = false
    var unminimizeSticks = true
    var stopAnsweringAfterRequest = false
    var reopenAdds: FakeWindow?
    var onRestore: () -> Void = {}
    var events: [String] = []
    var pauses = 0
    let parked = TargetWindowRecovery.ParkedWindows()

    init(identity: AXTreeProcessIdentity, windows: [FakeWindow]) {
        self.identity = identity
        self.windows = windows
    }

    func native() -> TargetWindowRecovery.NativeRuntime {
        TargetWindowRecovery.NativeRuntime(application: { [self] _ in
            TargetWindowRecovery.NativeApplication(
                identity: identity,
                isTerminated: { false },
                windows: { [self] in answers ? windows.map { nativeWindow($0) } : nil },
                reopenInBackground: { [self] in
                    events.append("reopen")
                    if let reopenAdds { windows.append(reopenAdds) }
                    return true
                }
            )
        })
    }

    private func nativeWindow(_ window: FakeWindow) -> TargetWindowRecovery.NativeWindow {
        TargetWindowRecovery.NativeWindow(
            id: { window.id },
            isMinimized: { window.minimized },
            setMinimized: { [self] value in
                events.append(value ? "minimize \(window.id)" : "unminimize \(window.id)")
                if unminimizeSticks { window.minimized = value }
                if !value {
                    if restoreShowsOnScreen { onScreen = true }
                    if stopAnsweringAfterRequest { answers = false }
                    onRestore()
                }
                return true
            },
            makeMain: { [self] in
                events.append("main \(window.id)")
                return true
            }
        )
    }

    func runtime(pid: pid_t, attempts: Int = 20) -> TargetWindowRecovery.Runtime {
        var runtime = TargetWindowRecovery.Runtime.live(
            native: native(),
            parked: parked,
            onScreen: { [self] _ in onScreen }
        )
        runtime.currentIdentity = { [self] _ in identity }
        runtime.pause = { [self] in pauses += 1 }
        runtime.attempts = attempts
        runtime.settleAttempts = 2
        runtime.guardForeground = { [self] _ in
            events.append("guard")
            return { [self] in events.append("release") }
        }
        return runtime
    }
}
