import CoreGraphics
import XCTest

@testable import cc_haha_computer_use

/// A fully covered Chromium window stops drawing while every action still
/// reports success. Measured on one real session: 22 captures, 6 distinct
/// images, the first 17 identical while the model clicked and typed through
/// them — and a final report claiming a song was playing that the last capture
/// showed paused, with the wrong title in the bar.
///
/// So coverage is not cosmetic, and it is worth being exact about.
final class WindowCoverageTests: XCTestCase {
    private let target = CGRect(x: 100, y: 100, width: 400, height: 300)

    func testAnUncoveredWindowIsNotCovered() {
        XCTAssertFalse(WindowGeometry.isCovered(target, by: []))
    }

    func testOneWindowLargerThanTheTargetCoversIt() {
        let big = CGRect(x: 0, y: 0, width: 1000, height: 800)
        XCTAssertTrue(WindowGeometry.isCovered(target, by: [big]))
    }

    func testAWindowOverlappingPartOfItDoesNotCount() {
        // Half covered still renders — Chromium only stops when nothing of the
        // window is visible, so a partial overlap must not trigger a recovery
        // that takes the screen away from the user for no reason.
        let half = CGRect(x: 100, y: 100, width: 400, height: 150)
        XCTAssertFalse(WindowGeometry.isCovered(target, by: [half]))
    }

    func testTwoWindowsCoveringDifferentHalvesCoverItTogether() {
        // The case a naive "does any single window contain it" check gets
        // wrong, and the common one: an editor over the top, a terminal below.
        let top = CGRect(x: 50, y: 50, width: 600, height: 200)
        let bottom = CGRect(x: 50, y: 250, width: 600, height: 300)
        XCTAssertTrue(WindowGeometry.isCovered(target, by: [top, bottom]))
    }

    func testTwoWindowsWithAHorizontalGapDoNotCoverIt() {
        // A sliver of the target shows between them, so it keeps painting.
        let top = CGRect(x: 50, y: 50, width: 600, height: 100)      // to y=150
        let bottom = CGRect(x: 50, y: 200, width: 600, height: 400)  // from y=200
        XCTAssertFalse(WindowGeometry.isCovered(target, by: [top, bottom]))
    }

    func testTwoWindowsSideBySideCoverItTogether() {
        let left = CGRect(x: 0, y: 0, width: 300, height: 800)
        let right = CGRect(x: 300, y: 0, width: 700, height: 800)
        XCTAssertTrue(WindowGeometry.isCovered(target, by: [left, right]))
    }

    func testSideBySideWindowsWithAVerticalGapDoNotCoverIt() {
        let left = CGRect(x: 0, y: 0, width: 250, height: 800)     // to x=250
        let right = CGRect(x: 300, y: 0, width: 700, height: 800)  // from x=300
        XCTAssertFalse(WindowGeometry.isCovered(target, by: [left, right]))
    }

    func testManySmallWindowsThatDoNotAddUpDoNotCoverIt() {
        let scraps = (0..<5).map { CGRect(x: 100 + $0 * 80, y: 100, width: 40, height: 300) }
        XCTAssertFalse(WindowGeometry.isCovered(target, by: scraps))
    }
}

final class TargetVisibilityPolicyTests: XCTestCase {
    private func source(_ name: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/cu-helper")
        return try String(contentsOf: root.appendingPathComponent(name), encoding: .utf8)
    }

    func testCoveredWindowWithStreamProviderNeverUsesOneShotFallback() {
        XCTAssertFalse(TargetVisibilityPolicy.permitsOneShotFallback(
            windowIsCovered: true,
            streamProviderInstalled: true
        ))
    }

    func testCaptureTargetMustRemainTheSameKeyWindow() {
        XCTAssertTrue(TargetVisibilityPolicy.captureTargetStillMatches(
            snapshotWindowID: 100,
            currentWindowID: 100
        ))
        XCTAssertTrue(TargetVisibilityPolicy.captureTargetStillMatches(
            snapshotWindowID: nil,
            currentWindowID: nil
        ))
        XCTAssertFalse(TargetVisibilityPolicy.captureTargetStillMatches(
            snapshotWindowID: 100,
            currentWindowID: 101
        ))
        XCTAssertFalse(TargetVisibilityPolicy.captureTargetStillMatches(
            snapshotWindowID: 100,
            currentWindowID: nil
        ))
        XCTAssertFalse(TargetVisibilityPolicy.captureTargetStillMatches(
            snapshotWindowID: nil,
            currentWindowID: 100
        ))
    }

    func testVisibleOrLegacyWindowCanUseOneShotFallback() {
        XCTAssertTrue(TargetVisibilityPolicy.permitsOneShotFallback(
            windowIsCovered: false,
            streamProviderInstalled: true
        ))
        XCTAssertTrue(TargetVisibilityPolicy.permitsOneShotFallback(
            windowIsCovered: true,
            streamProviderInstalled: false
        ))
    }

    /// Regression for session ba87fe5e-a2dc-4d93-932f-4c868df4c05e.
    ///
    /// `withForegroundLease` used to reject every mutation when another app
    /// covered the target. That put the guard in front of PID/window-targeted
    /// input and even in front of the AX `Raise` action the model tried as a
    /// recovery, so the task had no possible next move.
    func testOcclusionIsNotAMutationGate() throws {
        let router = try source("CommandRouter.swift")
        let body = try XCTUnwrap(
            router.range(of: "private func withForegroundLease").map {
                String(router[$0.lowerBound...])
            },
            "withForegroundLease is missing"
        )
        XCTAssertFalse(body.contains("ensureRenderableForMutation"))
        XCTAssertFalse(body.contains("window_occluded"))

        // Coverage is still measured for capture diagnostics elsewhere in the
        // router. Pin the absence of the old *gate* across the whole file so a
        // longer function cannot silently outrun a prefix-based source test.
        XCTAssertFalse(router.contains("ensureRenderableForMutation"))
        XCTAssertFalse(router.contains("window_occluded"))
    }

    /// Reading state must not reorder or activate a target just because the
    /// user covered it. Window-independent capture and app-targeted input are
    /// what make this background automation rather than foreground automation.
    func testGetAppStateDoesNotRaiseAnOccludedTarget() throws {
        let router = try source("CommandRouter.swift")
        let body = try XCTUnwrap(
            router.range(of: "private func handleGetAppState").flatMap { start in
                router.range(of: "struct ShotTransform", range: start.upperBound..<router.endIndex)
                    .map { end in String(router[start.lowerBound..<end.lowerBound]) }
            },
            "handleGetAppState is missing"
        )
        XCTAssertFalse(body.contains("ensureTargetIsRenderable"))
        XCTAssertFalse(body.contains("raiseWindow"))
        XCTAssertTrue(body.contains("coveredCaptureNotice"))
    }

    func testCoveredLiveStreamExplainsFreshFramesWithoutBlockingInput() {
        let notice = TargetVisibilityPolicy.coveredCaptureNotice(
            liveStreamActive: true
        )
        XCTAssertTrue(notice.contains("long-lived window stream"))
        XCTAssertTrue(notice.contains("new on-demand window screenshot"))
        XCTAssertTrue(notice.contains("does not prove the application responded"))
        XCTAssertFalse(notice.contains("may be stale"))
        XCTAssertFalse(notice.contains("paused its renderer"))
        XCTAssertFalse(notice.contains("refused"))
        XCTAssertFalse(notice.contains("Uncover the window"))
    }

    func testCoveredStreamFailureOmitsPotentiallyStaleOneShotPixels() {
        let notice = TargetVisibilityPolicy.coveredCaptureNotice(
            liveStreamActive: false
        )
        XCTAssertTrue(notice.contains("live window-stream frame was unavailable"))
        XCTAssertTrue(notice.contains("one-shot screenshot is intentionally not used"))
        XCTAssertTrue(notice.contains("compositor-cached pixels"))
        XCTAssertTrue(notice.contains("accessibility state"))
        XCTAssertTrue(notice.contains("does not block"))
    }

    /// An explicit AX Raise remains available, but it must not activate the app.
    func testUncoveringNeverActivatesTheApplication() throws {
        let source = try source("AXAction.swift")
        let body = try XCTUnwrap(
            source.range(of: "public static func raiseWindow").map {
                String(source[$0.lowerBound...].prefix(900))
            },
            "raiseWindow is missing"
        )
        XCTAssertFalse(
            body.contains("NSRunningApplication"),
            "raising a buried window must not activate its application"
        )
        XCTAssertFalse(
            body.contains(".activate("),
            "raising a buried window must not activate its application"
        )
    }

    func testTheIdenticalCaptureNoticeNamesTheToggleTrap() {
        for covered in [true, false] {
            for liveStreamActive in [true, false] {
                let notice = TargetVisibilityPolicy.identicalCaptureNotice(
                    windowIsCovered: covered,
                    liveStreamActive: liveStreamActive
                )
                XCTAssertTrue(notice.contains("byte-for-byte identical"))
                XCTAssertTrue(notice.contains("toggle"))
                XCTAssertTrue(notice.contains("undo the first"))
                XCTAssertFalse(notice.contains("refused"))
                XCTAssertFalse(notice.contains("Uncover the window"))
            }
        }
    }

    /// Behind the user's fullscreen app the same Chromium frame came back after
    /// actions that changed the page. "Not covered, so coverage does not
    /// explain it" would read those actions as failures.
    func testAWindowOffTheShownSpacesBlamesThePictureNotTheAction() {
        for liveStreamActive in [true, false] {
            let notice = TargetVisibilityPolicy.identicalCaptureNotice(
                windowIsCovered: false,
                liveStreamActive: liveStreamActive,
                windowIsOffScreen: true
            )
            XCTAssertTrue(notice.contains("not on a Space the user is looking at"))
            XCTAssertTrue(notice.contains("judge it from the accessibility state"))
            XCTAssertFalse(notice.contains("not fully covered"))
            XCTAssertFalse(notice.contains("coverage does not"))
        }
    }

    func testAVisibleWindowIsToldTheActionMissedRatherThanOfferedAnExcuse() {
        // The first draft said "the action missed OR the window is not
        // repainting — you cannot tell". The window was repainting the whole
        // time, and the model spent four minutes chasing the possibility we had
        // handed it. Coverage is something we compute, so it must not be
        // presented to the model as an open question.
        let visible = TargetVisibilityPolicy.identicalCaptureNotice(
            windowIsCovered: false,
            liveStreamActive: true
        )
        XCTAssertTrue(visible.contains("no visible pixel change"))
        XCTAssertTrue(visible.contains("not fully covered"))
        XCTAssertFalse(visible.contains("repainting"))
        XCTAssertFalse(visible.contains("paused its renderer"))

        let covered = TargetVisibilityPolicy.identicalCaptureNotice(
            windowIsCovered: true,
            liveStreamActive: true
        )
        XCTAssertTrue(covered.contains("long-lived window stream"))
        XCTAssertTrue(covered.contains("new on-demand screenshot"))
        XCTAssertTrue(covered.contains("does not establish whether"))
        XCTAssertTrue(covered.contains("no visible pixel change"))
        XCTAssertFalse(covered.contains("paused its renderer"))
    }
}
