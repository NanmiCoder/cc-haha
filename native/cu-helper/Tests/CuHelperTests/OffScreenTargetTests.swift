import CoreGraphics
import XCTest

@testable import cc_haha_computer_use

/// A minimized app produced a real screenshot, a real accessibility tree, and
/// "Action completed" for every click and keystroke of an entire session, while
/// nothing whatsoever happened. Two separate defects combined to hide it:
/// capture accepts off-screen windows, actuation cannot use them, and the gap
/// between the two was a silent fallback to an unbound event that custom
/// renderers discard.
///
/// These tests hold the on-screen binding refusal in place and what the model
/// is told when the target is off the shown Spaces. Binding a window on
/// another Space is covered by `OffScreenActuationTests`.
final class OffScreenTargetTests: XCTestCase {
    private let point = CGPoint(x: 410, y: 50)

    private func windowList(
        pid: pid_t,
        bounds: CGRect,
        layer: Int = 0
    ) -> () -> [[CFString: Any]]? {
        {
            [[
                kCGWindowLayer: layer,
                kCGWindowNumber: 4242,
                kCGWindowOwnerPID: pid,
                kCGWindowBounds: [
                    "X": bounds.minX,
                    "Y": bounds.minY,
                    "Width": bounds.width,
                    "Height": bounds.height,
                ] as [String: CGFloat],
            ]]
        }
    }

    // MARK: - The distinction that was missing

    func testAnAppWithNoOnScreenWindowIsReportedAsOffScreen() {
        // The whole failure: the window server lists on-screen windows only, so
        // a minimized target simply is not there. Reported as "your coordinate
        // missed", the model retries other coordinates forever.
        let result = WindowGeometry.binding(at: point, pid: 501, windowList: { [] })
        XCTAssertEqual(result, .failure(.noWindowOnScreen))
    }

    func testAMissedCoordinateIsNotReportedAsOffScreen() {
        // The app IS on screen; the point just falls outside its window. Here
        // re-reading coordinates is exactly the right move, so the two cases
        // must not collapse into one message.
        let result = WindowGeometry.binding(
            at: point,
            pid: 501,
            windowList: windowList(pid: 501, bounds: CGRect(x: 800, y: 400, width: 300, height: 200))
        )
        XCTAssertEqual(result, .failure(.pointOutsideWindows))
    }

    func testAWindowUnderThePointBinds() {
        let result = WindowGeometry.binding(
            at: point,
            pid: 501,
            windowList: windowList(pid: 501, bounds: CGRect(x: 0, y: 0, width: 1000, height: 800))
        )
        XCTAssertEqual(try? result.get().id, 4242)
    }

    func testAnotherAppsWindowUnderThePointDoesNotCount() {
        // Binding an event to a window the target does not own addresses it to
        // the wrong process, which is worse than refusing.
        let result = WindowGeometry.binding(
            at: point,
            pid: 501,
            windowList: windowList(pid: 999, bounds: CGRect(x: 0, y: 0, width: 1000, height: 800))
        )
        XCTAssertEqual(result, .failure(.noWindowOnScreen))
    }

    func testOverlayLayersDoNotMakeAnAppLookReachable() {
        // Layer 0 only. An app whose only surface is a panel or overlay cannot
        // receive an app-directed click, so it is off screen for our purposes.
        XCTAssertFalse(
            WindowGeometry.hasWindowOnScreen(
                pid: 501,
                windowList: windowList(
                    pid: 501,
                    bounds: CGRect(x: 0, y: 0, width: 100, height: 100),
                    layer: 25
                )
            )
        )
    }

    func testAZeroSizedWindowDoesNotCountAsOnScreen() {
        XCTAssertFalse(
            WindowGeometry.hasWindowOnScreen(
                pid: 501,
                windowList: windowList(pid: 501, bounds: .zero)
            )
        )
    }

    // MARK: - What the model is told

    func testEachOffScreenReasonIsNamed() {
        XCTAssertNil(OffScreenTargetAdvice.reason(hasWindowOnScreen: true, appIsHidden: false, keyWindowIsParked: false))
        XCTAssertEqual(OffScreenTargetAdvice.reason(hasWindowOnScreen: false, appIsHidden: false, keyWindowIsParked: false), .otherSpace)
        XCTAssertEqual(OffScreenTargetAdvice.reason(hasWindowOnScreen: false, appIsHidden: true, keyWindowIsParked: false), .hidden)
        // A parked window refuses input even if the app also has another
        // window on screen; that outranks everything.
        XCTAssertEqual(OffScreenTargetAdvice.reason(hasWindowOnScreen: true, appIsHidden: false, keyWindowIsParked: true), .parked)
    }

    func testAnotherSpaceKeepsTheModelWorkingWithoutBringingTheAppForward() {
        let notice = OffScreenTargetAdvice.notice(for: .otherSpace)
        XCTAssertTrue(notice.contains("Space the user is not looking at"))
        XCTAssertTrue(notice.contains("Keep working in the background"))
        XCTAssertTrue(notice.contains("Do not activate, raise, or reopen"))
        XCTAssertFalse(notice.contains("Do not retry with different coordinates"))
        XCTAssertFalse(notice.contains("ask the user to bring it"))
    }

    func testAPictureThatLagsIsNotReadAsAFailedApproach() {
        // Chromium stopped repainting on another Space: the same frame came
        // back across three actions that changed the page.
        for reason in [OffScreenTargetAdvice.Reason.otherSpace, .hidden] {
            let notice = OffScreenTargetAdvice.notice(for: reason)
            XCTAssertTrue(notice.contains("may be older than the accessibility state"), "\(reason)")
            XCTAssertTrue(notice.contains("does not\nmean an action failed or that the approach is wrong")
                || notice.contains("does not mean an action failed or that the approach is wrong"), "\(reason)")
            XCTAssertTrue(notice.contains("bare shell"), "\(reason)")
        }
    }

    func testAHiddenAppIsReadAsItIs() {
        let notice = OffScreenTargetAdvice.notice(for: .hidden)
        XCTAssertTrue(notice.contains("hidden (⌘H) and was read as it is"))
        XCTAssertTrue(notice.contains("without bringing it forward"))
        // The first click into a window just shown this way did not land.
        XCTAssertTrue(notice.contains("only shows it again"))
        XCTAssertTrue(notice.contains("read its state after that, then act"))
    }

    /// Restored from the Dock behind the user's fullscreen app, the window
    /// refused clicks until its Space was shown. The model must not believe
    /// "Action completed" there, nor keep retrying.
    func testAParkedWindowIsReportedAsRefusingInput() {
        let notice = OffScreenTargetAdvice.notice(for: .parked)
        XCTAssertTrue(notice.contains("does not deliver clicks or keys to it"))
        XCTAssertTrue(notice.contains("actions on it are refused"))
        XCTAssertTrue(notice.contains("Tell the user"))
        XCTAssertFalse(notice.contains("still delivered"))
    }
}
