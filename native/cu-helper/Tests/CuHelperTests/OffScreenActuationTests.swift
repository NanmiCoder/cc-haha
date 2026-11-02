import CoreGraphics
import XCTest

@testable import cc_haha_computer_use

/// Input into a target whose window is not on the Spaces the user is looking
/// at. Measured on a real machine with the user in a fullscreen app: a
/// Chromium window on another Space took window-targeted clicks and Unicode
/// keys, AX hit-testing answered with its menu bar, Command-V did not land, a
/// minimized window dropped clicks, and a window restored from the Dock while
/// its Space was hidden dropped them too. These tests drive the glue the
/// actions use, with fake window-server lists and window states.
@MainActor
final class OffScreenActuationTests: XCTestCase {
    private let pid: pid_t = 501
    private let identity = AXTreeProcessIdentity(
        bundleID: "com.example.target", executablePath: "/Applications/Target.app/Contents/MacOS/Target", launchTime: 7
    )
    private let snapshotWindow = WindowGeometry.Window(id: 777, bounds: CGRect(x: 0, y: 0, width: 1000, height: 800), ownerPid: 501)
    private let point = CGPoint(x: 410, y: 300)

    private func list(_ windows: [WindowGeometry.Window]) -> () -> [[CFString: Any]]? {
        {
            windows.map { window in
                [
                    kCGWindowLayer: 0,
                    kCGWindowNumber: Int(window.id),
                    kCGWindowOwnerPID: window.ownerPid,
                    kCGWindowBounds: [
                        "X": window.bounds.minX, "Y": window.bounds.minY,
                        "Width": window.bounds.width, "Height": window.bounds.height,
                    ] as [String: CGFloat],
                ]
            }
        }
    }

    private func neverAsked(_ id: CGWindowID) -> TargetWindowRecovery.WindowState {
        XCTFail("a window on a shown Space needs no state check")
        return .unknown
    }

    // MARK: - Coordinate binding

    func testTheSnapshotWindowOnAnotherSpaceTakesThePoint() throws {
        let window = try AXAction.bindableWindow(
            at: point, pid: pid, snapshotWindowID: 777,
            onScreenList: list([]), allSpacesList: list([snapshotWindow]),
            windowState: { _ in .takesInput }
        )
        XCTAssertEqual(window, snapshotWindow)
    }

    func testAShownWindowUnderThePointWinsWithoutAStateCheck() throws {
        let shown = WindowGeometry.Window(id: 4242, bounds: CGRect(x: 0, y: 0, width: 600, height: 600), ownerPid: pid)
        let window = try AXAction.bindableWindow(
            at: point, pid: pid, snapshotWindowID: 777,
            onScreenList: list([shown]), allSpacesList: list([shown, snapshotWindow]),
            windowState: neverAsked
        )
        XCTAssertEqual(window, shown)
    }

    func testEachBlockedStateIsRefusedWithItsOwnReason() {
        let expectations: [(TargetWindowRecovery.WindowState, String)] = [
            (.minimized, "minimized or closed"),
            (.gone, "minimized or closed"),
            (.parked, "came back onto a Space the user is not"),
            (.unknown, "did not answer accessibility queries"),
        ]
        for (state, phrase) in expectations {
            XCTAssertThrowsError(try AXAction.bindableWindow(
                at: point, pid: pid, snapshotWindowID: 777,
                onScreenList: list([]), allSpacesList: list([snapshotWindow]),
                windowState: { _ in state }
            ), "\(state)") { error in
                let error = error as? CUError
                XCTAssertEqual(error?.code, "target_window_offscreen", "\(state)")
                XCTAssertTrue(error?.message.contains(phrase) == true, "\(state): \(error?.message ?? "")")
            }
        }
    }

    func testAPointOutsideTheOffScreenWindowIsAMiss() {
        XCTAssertThrowsError(try AXAction.bindableWindow(
            at: CGPoint(x: 1500, y: 900), pid: pid, snapshotWindowID: 777,
            onScreenList: list([]), allSpacesList: list([snapshotWindow]),
            windowState: { _ in .takesInput }
        )) { XCTAssertEqual(($0 as? CUError)?.code, "point_outside_target_window") }
    }

    func testAnotherProcessesWindowNeverTakesThePoint() {
        let foreign = WindowGeometry.Window(id: 777, bounds: snapshotWindow.bounds, ownerPid: 999)
        XCTAssertThrowsError(try AXAction.bindableWindow(
            at: point, pid: pid, snapshotWindowID: 777,
            onScreenList: list([]), allSpacesList: list([foreign]),
            windowState: { _ in .takesInput }
        )) { XCTAssertEqual(($0 as? CUError)?.code, "target_window_offscreen") }
    }

    // MARK: - Keyboard window

    func testKeysGoToTheSnapshotWindowOnAnotherSpace() throws {
        let snapshot = AXTreeSnapshotEvidence(processIdentity: identity, keyWindowID: 777)
        let window = try AXAction.keyboardWindow(
            pid: pid, snapshot: snapshot, currentIdentity: identity,
            onScreenList: list([]), allSpacesList: list([snapshotWindow]),
            windowState: { _ in .takesInput }
        )
        XCTAssertEqual(window, snapshotWindow)

        XCTAssertThrowsError(try AXAction.keyboardWindow(
            pid: pid, snapshot: snapshot, currentIdentity: identity,
            onScreenList: list([]), allSpacesList: list([snapshotWindow]),
            windowState: { _ in .minimized }
        )) { XCTAssertEqual(($0 as? CUError)?.code, "target_window_offscreen") }
    }

    // MARK: - A hidden app shown by the action

    /// Shown behind the user's fullscreen app, its window did not reliably take
    /// clicks. It is parked and the action refused, not reported as sent.
    func testAWindowShownOntoAHiddenSpaceIsParkedAndRefused() async {
        let parked = TargetWindowRecovery.ParkedWindows()
        var pauses = 0
        do {
            try await AXAction.requireShownWindow(
                pid: pid, window: snapshotWindow,
                isOnScreen: { _ in false }, identity: identity, parked: parked,
                attempts: 3, pause: { pauses += 1 }
            )
            XCTFail("a window that never appears on a shown Space must not take input")
        } catch let error as CUError {
            XCTAssertEqual(error.code, "target_window_offscreen")
            XCTAssertTrue(error.message.contains("shown after being"))
        } catch {
            XCTFail("\(error)")
        }
        XCTAssertEqual(pauses, 3)
        XCTAssertTrue(parked.isParked(pid: pid, identity: identity, windowID: 777))
    }

    func testAWindowShownOnTheUsersSpaceTakesInput() async throws {
        // Same desktop: the shown window appears and the click landed.
        let parked = TargetWindowRecovery.ParkedWindows()
        var shown = false
        try await AXAction.requireShownWindow(
            pid: pid, window: snapshotWindow,
            isOnScreen: { _ in shown }, identity: identity, parked: parked,
            attempts: 3, pause: { shown = true }
        )
        XCTAssertFalse(parked.isParked(pid: pid, identity: identity, windowID: 777))
    }

    func testShowingAHiddenAppIsTheWholeAction() throws {
        let message = AXAction.shownAgainError.message
        XCTAssertTrue(message.contains("nothing else was sent"))
        XCTAssertTrue(message.contains("Call get_app_state, then repeat the action"))

        // Every input path prepares through this one function; a hidden app
        // must be checked for its Space and then stop before any input.
        let source = try String(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/cu-helper/AXAction.swift"), encoding: .utf8)
        let body = try XCTUnwrap(source.range(of: "private static func ensureTargetAcceptsInput").map {
            String(source[$0.lowerBound...].prefix(900))
        })
        let shown = try XCTUnwrap(body.range(of: "try await requireShownWindow(pid: pid, window: window)"))
        let stop = try XCTUnwrap(body.range(of: "throw shownAgainError"))
        XCTAssertLessThan(shown.lowerBound, stop.lowerBound)
    }

    // MARK: - Revalidation right before posting

    func testAWindowMinimizedAfterBindingIsNoLongerBound() {
        // The window server keeps a minimized window, with its old frame, in
        // the all-Spaces list; only its state shows it cannot take input.
        XCTAssertFalse(AXAction.isStillBound(
            snapshotWindow, pid: pid,
            onScreenList: list([]), allSpacesList: list([snapshotWindow]),
            windowState: { _ in .minimized }
        ))
        XCTAssertTrue(AXAction.isStillBound(
            snapshotWindow, pid: pid,
            onScreenList: list([]), allSpacesList: list([snapshotWindow]),
            windowState: { _ in .takesInput }
        ))
        XCTAssertTrue(AXAction.isStillBound(
            snapshotWindow, pid: pid,
            onScreenList: list([snapshotWindow]), allSpacesList: list([snapshotWindow]),
            windowState: neverAsked
        ))
        let moved = WindowGeometry.Window(id: 777, bounds: CGRect(x: 40, y: 0, width: 1000, height: 800), ownerPid: pid)
        XCTAssertFalse(AXAction.isStillBound(
            snapshotWindow, pid: pid,
            onScreenList: list([]), allSpacesList: list([moved]),
            windowState: { _ in .takesInput }
        ))
    }

    // MARK: - Click routing and typing

    func testAPointOnAnotherSpaceSkipsTheAccessibilityHitTest() {
        XCTAssertFalse(AXAction.coordinateClickPrefersAccessibility(
            at: point, pid: pid, button: .left, onScreenList: list([])
        ))
        XCTAssertTrue(AXAction.coordinateClickPrefersAccessibility(
            at: point, pid: pid, button: .left, onScreenList: list([snapshotWindow])
        ))
        XCTAssertFalse(AXAction.coordinateClickPrefersAccessibility(
            at: point, pid: pid, button: .right, onScreenList: list([snapshotWindow])
        ))
    }

    func testUnicodeKeysOnlyWhereTheyWereMeasuredToLand() {
        func fallback(_ focused: String?, onScreen: Bool) -> AXAction.TextFallback {
            AXAction.textFallback(
                focused: focused, isTextEntry: { $0 == "field" },
                windowID: 777, pid: pid,
                onScreenList: list(onScreen ? [snapshotWindow] : [])
            )
        }
        // No focused element AX can see, window on another Space: the case
        // where Unicode keys landed and Command-V did not.
        XCTAssertEqual(fallback(nil, onScreen: false), .unicodeKeys)
        // A focused button must not receive a space or return as text.
        XCTAssertEqual(fallback("button", onScreen: false), .clipboardPaste)
        XCTAssertEqual(fallback("field", onScreen: true), .unicodeKeys)
        XCTAssertEqual(fallback(nil, onScreen: true), .clipboardPaste)
    }
}
