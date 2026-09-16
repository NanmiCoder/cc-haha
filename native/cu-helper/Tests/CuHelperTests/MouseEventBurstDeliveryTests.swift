import AppKit
import CoreGraphics
import XCTest

@testable import cc_haha_computer_use

final class MouseEventBurstDeliveryTests: XCTestCase {
    private enum ExpectedError: Error, Equatable {
        case invalidTarget
        case pauseFailed
        case cleanupFailed
    }

    @MainActor
    func testProductionClickAllocationAndDeliveryContainOnlyMatchingDownUpPairs() async throws {
        let source = try XCTUnwrap(CGEventSource(stateID: .privateState))
        let window = WindowGeometry.Window(
            id: 123, bounds: CGRect(x: 200, y: 300, width: 800, height: 600), ownerPid: 456
        )
        let point = CGPoint(x: 410, y: 349)
        for button: MouseButton in [.left, .right, .middle] {
            for count in [1, 2] {
                let events = try AXAction.clickEvents(
                    at: point, clickCount: count, button: button,
                    source: source, pid: window.ownerPid, window: window
                )
                var posted: [CGEvent] = []
                var validations = 0
                try await MouseEventBurstDelivery.deliver(
                    events: events,
                    validate: { validations += 1 },
                    post: { posted.append($0) },
                    release: { _, _ in XCTFail("a complete click must not need cleanup") },
                    pause: {}
                )
                XCTAssertEqual(posted.map(\.type), (0..<count).flatMap { _ in [button.down, button.up] })
                XCTAssertEqual(validations, count * 2)
                for (index, event) in posted.enumerated() {
                    XCTAssertTrue(event === events[index], "delivery must use the production allocation")
                    XCTAssertEqual(event.location, point)
                    XCTAssertEqual(event.getIntegerValueField(.mouseEventClickState), Int64(index / 2 + 1))
                    XCTAssertEqual(event.getIntegerValueField(CGEventField(rawValue: 91)!), Int64(window.id))
                    XCTAssertEqual(event.getIntegerValueField(CGEventField(rawValue: 92)!), Int64(window.id))
                    XCTAssertEqual(try XCTUnwrap(NSEvent(cgEvent: event)).windowNumber, Int(window.id))
                }
                let numbers = posted.map { $0.getIntegerValueField(.mouseEventNumber) }
                for index in stride(from: 0, to: count * 2, by: 2) {
                    XCTAssertEqual(numbers[index], numbers[index + 1])
                }
                XCTAssertEqual(Set(stride(from: 0, to: count * 2, by: 2).map { numbers[$0] }).count, count)
            }
        }
    }

    @MainActor
    func testUnpacedProductionDoubleClickDoesNotYieldBetweenPairs() async throws {
        let window = WindowGeometry.Window(
            id: 123, bounds: CGRect(x: 200, y: 300, width: 800, height: 600), ownerPid: 456
        )
        let events = try AXAction.clickEvents(
            at: CGPoint(x: 410, y: 349), clickCount: 2, button: .left,
            source: XCTUnwrap(CGEventSource(stateID: .privateState)), pid: window.ownerPid, window: window
        )
        var queuedTask: Task<Void, Never>?
        var yielded = false
        var posted: [CGEventType] = []
        var trace: [String] = []

        try await MouseEventBurstDelivery.deliver(
            events: events,
            validate: { trace.append("validate") },
            post: {
                XCTAssertFalse(yielded, "ordinary click pairs must stay in one main-actor turn")
                posted.append($0.type)
                trace.append("post")
                if posted.count == 1 {
                    queuedTask = Task { @MainActor in yielded = true }
                }
            },
            release: { _, _ in XCTFail("complete double-click already released its buttons") }
        )
        XCTAssertEqual(posted, [.leftMouseDown, .leftMouseUp, .leftMouseDown, .leftMouseUp])
        XCTAssertEqual(trace, Array(repeating: ["validate", "post"], count: 4).flatMap { $0 })
        await queuedTask?.value
        XCTAssertTrue(yielded)
    }

    @MainActor
    func testUnpacedCancellationBeforeFirstAfterDownAndAfterUpNeverStartsTheNextClick() async throws {
        let events = try makeEvents([.leftMouseDown, .leftMouseUp, .leftMouseDown, .leftMouseUp])
        for cancelAfterPost in 0...events.count {
            var posted: [CGEventType] = []
            var releases: [(CGEvent, CGPoint)] = []
            let task = Task { @MainActor in
                if cancelAfterPost == 0 { withUnsafeCurrentTask { $0?.cancel() } }
                do {
                    try await MouseEventBurstDelivery.deliver(
                        events: events,
                        validate: {},
                        post: {
                            posted.append($0.type)
                            if posted.count == cancelAfterPost { withUnsafeCurrentTask { $0?.cancel() } }
                        },
                        release: { releases.append(($0, $1)) }
                    )
                    XCTFail("canceled unpaced delivery must throw, including after the final up")
                } catch is CancellationError {
                    // Cancellation is observed even without a pause callback.
                } catch {
                    XCTFail("unexpected error: \(error)")
                }
            }
            await task.value
            XCTAssertEqual(posted, events.prefix(cancelAfterPost).map(\.type))
            XCTAssertEqual(releases.count, cancelAfterPost.isMultiple(of: 2) ? 0 : 1)
            if let release = releases.first {
                XCTAssertTrue(release.0 === events[cancelAfterPost - 1])
                XCTAssertEqual(release.1, events[cancelAfterPost - 1].location)
            }
        }
    }

    @MainActor
    func testUnpacedValidationFailureReleasesOnlyItsHeldDownAndPreservesOriginalError() async throws {
        let events = try makeEvents([.leftMouseDown, .leftMouseUp, .leftMouseDown, .leftMouseUp])
        var posted: [CGEventType] = []
        var releases = 0
        do {
            try await MouseEventBurstDelivery.deliver(
                events: events,
                validate: { if !posted.isEmpty { throw ExpectedError.invalidTarget } },
                post: { posted.append($0.type) },
                release: { down, point in
                    XCTAssertTrue(down === events[0])
                    XCTAssertEqual(point, events[0].location)
                    releases += 1
                    throw ExpectedError.cleanupFailed
                }
            )
            XCTFail("the invalid target must stop the burst")
        } catch {
            XCTAssertEqual(error as? ExpectedError, .invalidTarget)
        }
        XCTAssertEqual(posted, [.leftMouseDown])
        XCTAssertEqual(releases, 1)
    }

    func testCoordinateClickUsesTheTestedFactoryAndExplicitlyUnpacedDelivery() throws {
        let source = try String(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/cu-helper/AXAction.swift"), encoding: .utf8)
        let start = try XCTUnwrap(source.range(of: "public static func clickPoint("))
        let end = try XCTUnwrap(source.range(of: "static func clickEvents(", range: start.upperBound..<source.endIndex))
        let body = String(source[start.upperBound..<end.lowerBound])
        XCTAssertTrue(body.contains("let events = try clickEvents("))
        XCTAssertTrue(body.contains("try await postMouseBurst("))
        XCTAssertTrue(body.contains("pause: nil"), "coordinate click must not insert an artificial per-event delay")
    }

    @MainActor
    func testSuccessfulBurstValidatesEveryPostAndDoesNotReleaseTwice() async throws {
        let events = try makeEvents([.mouseMoved, .leftMouseDown, .leftMouseDragged, .leftMouseUp])
        var trace: [String] = []
        var posted: [CGEventType] = []

        try await MouseEventBurstDelivery.deliver(
            events: events,
            validate: { trace.append("validate") },
            post: { posted.append($0.type); trace.append("post") },
            release: { _, _ in XCTFail("normal mouse-up already released the button") },
            pause: { trace.append("pause") }
        )

        XCTAssertEqual(posted, events.map(\.type))
        XCTAssertEqual(trace, Array(repeating: ["validate", "post", "pause"], count: events.count).flatMap { $0 })
    }

    @MainActor
    func testCancellationBeforeFirstEventAfterMoveAfterDownAndAfterUpStopsTheBurst() async throws {
        let events = try makeEvents([
            .mouseMoved, .leftMouseDown, .leftMouseUp,
            .leftMouseDown, .leftMouseUp,
        ])

        // Exercise real Task cancellation, including a pause that returns
        // normally instead of throwing cancellation itself.
        for cancelAfterPost in 0...events.count {
            var posted: [CGEventType] = []
            var releases: [(CGEvent, CGPoint)] = []
            var validations = 0
            let task = Task { @MainActor in
                if cancelAfterPost == 0 { withUnsafeCurrentTask { $0?.cancel() } }
                do {
                    try await MouseEventBurstDelivery.deliver(
                        events: events,
                        validate: { validations += 1 },
                        post: { posted.append($0.type) },
                        release: { releases.append(($0, $1)) },
                        pause: {
                            if posted.count == cancelAfterPost {
                                withUnsafeCurrentTask { $0?.cancel() }
                            }
                        }
                    )
                    XCTFail("cancelled delivery must not report success")
                } catch is CancellationError {
                    // Expected: only a down that was actually posted needs cleanup.
                } catch {
                    XCTFail("unexpected error: \(error)")
                }
            }
            await task.value

            XCTAssertEqual(posted, events.prefix(cancelAfterPost).map(\.type))
            XCTAssertEqual(validations, cancelAfterPost)
            let heldIndex: Int? = switch cancelAfterPost {
            case 2: 1
            case 4: 3
            default: nil
            }
            XCTAssertEqual(releases.count, heldIndex == nil ? 0 : 1)
            if let release = releases.first {
                let index = try XCTUnwrap(heldIndex)
                XCTAssertTrue(release.0 === events[index])
                XCTAssertEqual(release.1, events[index].location)
            }
        }
    }

    @MainActor
    func testDragCleanupUsesLastPostedPointNotUnsentDestination() async throws {
        let events = try makeEvents([.leftMouseDown, .leftMouseDragged, .leftMouseDragged, .leftMouseUp])
        var posted: [CGEventType] = []
        var releases: [(CGEvent, CGPoint)] = []

        do {
            try await MouseEventBurstDelivery.deliver(
                events: events,
                validate: {},
                post: { posted.append($0.type) },
                release: { releases.append(($0, $1)) },
                pause: { if posted.count == 2 { throw ExpectedError.pauseFailed } }
            )
            XCTFail("expected the pause to fail")
        } catch {
            XCTAssertEqual(error as? ExpectedError, .pauseFailed)
        }

        XCTAssertEqual(posted, [.leftMouseDown, .leftMouseDragged])
        XCTAssertEqual(releases.count, 1)
        let release = try XCTUnwrap(releases.first)
        XCTAssertTrue(release.0 === events[0])
        XCTAssertEqual(release.1, events[1].location)
        XCTAssertNotEqual(release.1, events.last?.location)
    }

    @MainActor
    func testValidationBeforeFirstPostRejectsWithoutCleanup() async throws {
        var posted = false
        var released = false
        do {
            try await MouseEventBurstDelivery.deliver(
                events: makeEvents([.leftMouseDown, .leftMouseUp]),
                validate: { throw ExpectedError.invalidTarget },
                post: { _ in posted = true },
                release: { _, _ in released = true },
                pause: { XCTFail("no event was sent") }
            )
            XCTFail("expected validation failure")
        } catch {
            XCTAssertEqual(error as? ExpectedError, .invalidTarget)
        }
        XCTAssertFalse(posted)
        XCTAssertFalse(released)
    }

    @MainActor
    func testCancellationDuringValidationDoesNotPostTheValidatedEvent() async throws {
        let events = try makeEvents([.leftMouseDown, .leftMouseUp])
        var posted = false
        let task = Task { @MainActor in
            do {
                try await MouseEventBurstDelivery.deliver(
                    events: events,
                    validate: { withUnsafeCurrentTask { $0?.cancel() } },
                    post: { _ in posted = true },
                    release: { _, _ in XCTFail("no down was posted") },
                    pause: { XCTFail("no event was posted") }
                )
                XCTFail("cancelled validation must prevent posting")
            } catch is CancellationError {
                // Expected.
            } catch {
                XCTFail("unexpected error: \(error)")
            }
        }
        await task.value
        XCTAssertFalse(posted)
    }

    @MainActor
    func testValidationAfterYieldStopsAndReleasesOnlyPreviouslyPostedDown() async throws {
        let events = try makeEvents([.rightMouseDown, .rightMouseDragged, .rightMouseUp])
        var targetValid = true
        var posted: [CGEventType] = []
        var releases: [(CGEvent, CGPoint)] = []
        do {
            try await MouseEventBurstDelivery.deliver(
                events: events,
                validate: { if !targetValid { throw ExpectedError.invalidTarget } },
                post: { posted.append($0.type) },
                release: { releases.append(($0, $1)) },
                pause: { targetValid = false }
            )
            XCTFail("expected post-yield validation failure")
        } catch {
            XCTAssertEqual(error as? ExpectedError, .invalidTarget)
        }
        XCTAssertEqual(posted, [.rightMouseDown])
        XCTAssertEqual(releases.count, 1)
        XCTAssertTrue(releases.first?.0 === events[0])
        XCTAssertEqual(releases.first?.1, events[0].location)
    }

    @MainActor
    func testCleanupFailureDoesNotReplaceTheOriginalErrorOrRetryRelease() async throws {
        var posted: [CGEventType] = []
        var releaseCount = 0
        do {
            try await MouseEventBurstDelivery.deliver(
                events: makeEvents([.otherMouseDown, .otherMouseDragged, .otherMouseUp]),
                validate: {},
                post: { posted.append($0.type) },
                release: { down, _ in
                    XCTAssertEqual(down.type, .otherMouseDown)
                    releaseCount += 1
                    throw ExpectedError.cleanupFailed
                },
                pause: { throw ExpectedError.pauseFailed }
            )
            XCTFail("expected pause failure")
        } catch {
            XCTAssertEqual(error as? ExpectedError, .pauseFailed)
        }
        XCTAssertEqual(posted, [.otherMouseDown])
        XCTAssertEqual(releaseCount, 1)
    }

    @MainActor
    func testMatchingRightAndOtherMouseUpClearHeldStateBeforePauseFailure() async throws {
        for pair: [CGEventType] in [[.rightMouseDown, .rightMouseUp], [.otherMouseDown, .otherMouseUp]] {
            var posted: [CGEventType] = []
            do {
                try await MouseEventBurstDelivery.deliver(
                    events: makeEvents(pair),
                    validate: {},
                    post: { posted.append($0.type) },
                    release: { _, _ in XCTFail("button has already been released") },
                    pause: { if posted.count == 2 { throw ExpectedError.pauseFailed } }
                )
                XCTFail("expected final pause failure")
            } catch {
                XCTAssertEqual(error as? ExpectedError, .pauseFailed)
            }
            XCTAssertEqual(posted, pair)
        }
    }

    private func makeEvents(_ types: [CGEventType]) throws -> [CGEvent] {
        let source = try XCTUnwrap(CGEventSource(stateID: .privateState))
        return try types.enumerated().map { index, type in
            let button: CGMouseButton
            switch type {
            case .rightMouseDown, .rightMouseUp, .rightMouseDragged: button = .right
            case .otherMouseDown, .otherMouseUp, .otherMouseDragged: button = .center
            default: button = .left
            }
            return try XCTUnwrap(CGEvent(
                mouseEventSource: source, mouseType: type,
                mouseCursorPosition: CGPoint(x: 10 + index * 20, y: 20 + index * 15),
                mouseButton: button
            ))
        }
    }
}
