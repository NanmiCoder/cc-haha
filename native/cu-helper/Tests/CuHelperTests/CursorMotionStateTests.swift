import CoreGraphics
import XCTest
@testable import cc_haha_computer_use

final class CursorMotionStateTests: XCTestCase {
    func testStartingGlideDoesNotJumpCurrentPositionToDestination() {
        var motion = CursorMotionState(position: CGPoint(x: 0, y: 0))

        motion.startGlide(to: CGPoint(x: 100, y: 0))

        XCTAssertEqual(motion.position, CGPoint(x: 0, y: 0))
        XCTAssertEqual(motion.destination, CGPoint(x: 100, y: 0))
    }

    func testFirstTickLandsBetweenSourceAndDestination() {
        var motion = CursorMotionState(position: CGPoint(x: 0, y: 0))
        motion.startGlide(to: CGPoint(x: 100, y: 0))

        motion.tick(deltaTime: 1.0 / 60.0)

        XCTAssertGreaterThan(motion.position.x, 0)
        XCTAssertLessThan(motion.position.x, 100)
        XCTAssertEqual(motion.position.y, 0, accuracy: 0.001)
    }

    func testRedirectStartsFromCurrentAnimatedPointAndReplacesDestination() {
        var motion = CursorMotionState(position: CGPoint(x: 0, y: 0))
        motion.startGlide(to: CGPoint(x: 100, y: 0))
        motion.tick(deltaTime: 1.0 / 60.0)
        let redirectPoint = motion.position

        motion.startGlide(to: CGPoint(x: -100, y: 0))

        XCTAssertEqual(motion.position, redirectPoint)
        XCTAssertEqual(motion.destination, CGPoint(x: -100, y: 0))
    }

    @MainActor
    func testBackgroundActionSnapsAndWaitsZero() async {
        let decision = OverlayPolicy.decision(
            targetPid: 41,
            frontmostPid: 99,
            overlayRequested: true,
            targetWindowExposed: false
        )
        var events: [String] = []

        await CursorActionTiming.perform(
            decision: decision,
            startGlide: { events.append("glide") },
            snap: { events.append("snap") },
            sleep: { _ in events.append("sleep") }
        )

        XCTAssertEqual(events, ["snap"])
    }

    @MainActor
    func testForegroundActionStartsGlideBeforeShortDelayWithoutAwaitingCompletion() async {
        let decision = OverlayPolicy.decision(
            targetPid: 41,
            frontmostPid: 41,
            overlayRequested: true,
            targetWindowExposed: false
        )
        var events: [String] = []
        var sleptFor: TimeInterval?

        await CursorActionTiming.perform(
            decision: decision,
            startGlide: { events.append("glide-started") },
            snap: { events.append("snap") },
            sleep: { delay in
                sleptFor = delay
                events.append("short-delay")
            }
        )

        XCTAssertEqual(events, ["glide-started", "short-delay"])
        XCTAssertEqual(sleptFor, decision.actionDelay)
    }

    @MainActor
    func testCoordinateActionsStartVisibleFeedbackWithoutSleepingAtAnyDistance() async {
        for frontmostPid: pid_t in [41, 99] {
            let decision = OverlayPolicy.decision(
                targetPid: 41, frontmostPid: frontmostPid,
                overlayRequested: true, targetWindowExposed: true
            )
            XCTAssertTrue(decision.visible)
            XCTAssertGreaterThan(decision.actionDelay, 0, "the element-action policy remains available")
            let origin = CGPoint(x: 410, y: 349)
            for destination in [origin, CGPoint(x: 411, y: 349), CGPoint(x: -1000, y: 1400)] {
                var motion = CursorMotionState(position: origin)
                var events: [String] = []
                await CursorActionTiming.perform(
                    decision: decision,
                    waitForVisualFeedback: false,
                    startGlide: {
                        motion.startGlide(to: destination)
                        events.append("glide-started")
                    },
                    snap: { events.append("snap") },
                    sleep: { _ in events.append("sleep") }
                )
                events.append("returned")
                XCTAssertEqual(events, ["glide-started", "returned"])
                XCTAssertEqual(motion.destination, destination, "visual feedback must still be started")
                XCTAssertEqual(motion.position, origin, "input must not wait for the displayed cursor to arrive")
            }
        }
    }

    @MainActor
    func testCoveredCoordinateActionStillSnapsWithoutStartingHiddenAnimation() async {
        let decision = OverlayPolicy.decision(
            targetPid: 41, frontmostPid: 99,
            overlayRequested: true, targetWindowExposed: false
        )
        var events: [String] = []
        await CursorActionTiming.perform(
            decision: decision,
            waitForVisualFeedback: false,
            startGlide: { events.append("glide") },
            snap: { events.append("snap") },
            sleep: { _ in events.append("sleep") }
        )
        XCTAssertEqual(events, ["snap"])
    }

    func testRouterSkipsOnlyCoordinateVisualWaitsAndPreservesPostMoveValidation() throws {
        // These wiring checks complement the executable timing seam tests;
        // resolving real app windows would make a unit test mutate user UI.
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/cu-helper")
        let router = try String(contentsOf: root.appendingPathComponent("CommandRouter.swift"), encoding: .utf8)
        let clickStart = try XCTUnwrap(router.range(of: "private func handleClick("))
        let indexedStart = try XCTUnwrap(router.range(of: "// Index click", range: clickStart.upperBound..<router.endIndex))
        let clickEnd = try XCTUnwrap(router.range(of: "private func handleSetValue(", range: indexedStart.upperBound..<router.endIndex))
        let coordinateClick = String(router[clickStart.upperBound..<indexedStart.lowerBound])
        let indexedClick = String(router[indexedStart.upperBound..<clickEnd.lowerBound])
        let dragStart = try XCTUnwrap(router.range(of: "private func handleDrag("))
        let dragEnd = try XCTUnwrap(router.range(of: "// MARK: - Target resolution", range: dragStart.upperBound..<router.endIndex))
        let drag = String(router[dragStart.upperBound..<dragEnd.lowerBound])

        for action in [coordinateClick, drag] {
            let move = try XCTUnwrap(action.range(of: "waitForVisualFeedback: false"))
            let afterMove = action[move.upperBound...]
            XCTAssertTrue(afterMove.contains("Self.validatedGlobalPoint("))
            XCTAssertTrue(afterMove.contains("Injection.validateAuthorizedTarget(target)"))
        }
        XCTAssertTrue(coordinateClick.contains("cursor.showClick("), "the click ripple remains active")
        XCTAssertTrue(drag.contains("cursor.move(to: from, animated: false)"))
        XCTAssertTrue(indexedClick.contains("cursor.moveForAction("))
        XCTAssertFalse(indexedClick.contains("waitForVisualFeedback: false"), "element actions retain their current policy")
        XCTAssertTrue(indexedClick.contains("CursorIndexedActionGate.perform("))
        XCTAssertTrue(indexedClick.contains("guardStaleness(pid:"))

        let cursor = try String(contentsOf: root.appendingPathComponent("VirtualCursor.swift"), encoding: .utf8)
        XCTAssertTrue(cursor.contains("waitForVisualFeedback: Bool = true"))
        XCTAssertTrue(cursor.contains("waitForVisualFeedback: waitForVisualFeedback"), "the live cursor must use the tested timing seam")
    }

    @MainActor
    func testIndexedActionRechecksStalenessAfterCursorDelayBeforeMutation() async {
        var events: [String] = []

        await CursorIndexedActionGate.perform(
            moveForAction: { events.append("move-delay-finished") },
            recheckStaleness: { events.append("stale-rechecked") },
            mutate: { events.append("mutated") }
        )

        XCTAssertEqual(events, ["move-delay-finished", "stale-rechecked", "mutated"])
    }

    @MainActor
    func testIndexedActionDoesNotMutateWhenPostDelayStalenessCheckFails() async {
        enum ExpectedError: Error { case stale }
        var mutated = false

        do {
            try await CursorIndexedActionGate.perform(
                moveForAction: {},
                recheckStaleness: { throw ExpectedError.stale },
                mutate: { mutated = true }
            )
            XCTFail("expected stale recheck to fail")
        } catch ExpectedError.stale {
            XCTAssertFalse(mutated)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    @MainActor
    func testIndexedActionAwaitsAsyncMutationBeforeReturningItsCommittedResult() async {
        var events: [String] = []
        let result = await CursorIndexedActionGate.perform(
            moveForAction: { events.append("moved") },
            recheckStaleness: { events.append("validated") },
            mutate: {
                events.append("mutation-started")
                let resultTask = Task { @MainActor in
                    events.append("async-result-ready")
                    return "committed"
                }
                let result = await resultTask.value
                events.append("mutation-finished")
                return result
            }
        )
        events.append("returned")

        XCTAssertEqual(result, "committed")
        XCTAssertEqual(events, [
            "moved", "validated", "mutation-started", "async-result-ready",
            "mutation-finished", "returned",
        ])
    }

    @MainActor
    func testIndexedActionPropagatesFailureFromSuspendedMutationWithoutCommitting() async {
        enum ExpectedError: Error { case mutationFailed }
        var events: [String] = []
        do {
            try await CursorIndexedActionGate.perform(
                moveForAction: { events.append("moved") },
                recheckStaleness: { events.append("validated") },
                mutate: {
                    events.append("mutation-started")
                    let failureTask = Task { @MainActor in
                        events.append("async-failure")
                        throw ExpectedError.mutationFailed
                    }
                    try await failureTask.value
                }
            )
            XCTFail("a failed async mutation must not commit")
        } catch ExpectedError.mutationFailed {
            events.append("failed")
        } catch {
            XCTFail("unexpected error: \(error)")
        }

        XCTAssertEqual(events, [
            "moved", "validated", "mutation-started", "async-failure", "failed",
        ])
    }
}
