import AppKit
import CoreGraphics
import XCTest

@testable import cc_haha_computer_use

/// Exercises the events allocated by the production drag path without posting
/// them to any application. The sequence comes from the installed official
/// SkyComputerUseService 26.831.1000926 SynthesizedEvent.click specialization:
/// down(origin), dragged(origin), dragged(midpoint), dragged(destination), up.
final class MouseDragEventTests: XCTestCase {
    @MainActor
    func testStationaryDragRetainsTheCompleteGesture() throws {
        try assertDrag(from: CGPoint(x: 410, y: 349), to: CGPoint(x: 410, y: 349))
    }

    @MainActor
    func testOnePixelDragKeepsItsFractionalMidpoint() throws {
        try assertDrag(from: CGPoint(x: 410, y: 349), to: CGPoint(x: 411, y: 350))
    }

    @MainActor
    func testLongDragUsesTheSameFiveEventsAndOriginWindow() throws {
        // The destination can leave the origin window. It must not be clamped
        // or rebound to a different window during allocation.
        try assertDrag(from: CGPoint(x: 410, y: 349), to: CGPoint(x: 2410, y: 1749))
    }

    @MainActor
    func testDragAcrossNegativeDisplayCoordinatesPreservesGlobalPositions() throws {
        try assertDrag(from: CGPoint(x: -2201, y: -1001), to: CGPoint(x: -21, y: 499))
    }

    @MainActor
    func testProductionDragFieldsPairTransitionsSeparatelyFromMotionForEveryButton() throws {
        let window = fixtureWindow
        for button: MouseButton in [.left, .right, .middle] {
            let events = try makeDrag(from: CGPoint(x: 410, y: 349), to: CGPoint(x: 411, y: 349), button: button)
            XCTAssertEqual(events.map(\.type), [button.down, button.dragged, button.dragged, button.dragged, button.up])
            XCTAssertEqual(events.map { $0.getIntegerValueField(.mouseEventClickState) }, [1, 0, 0, 0, 1])
            guard events.count == 5 else { continue }
            let numbers = events.map { $0.getIntegerValueField(.mouseEventNumber) }
            XCTAssertEqual(numbers[0], numbers[4], "down and up must identify the same gesture")
            XCTAssertEqual(numbers[1], numbers[2])
            XCTAssertEqual(numbers[2], numbers[3])
            XCTAssertNotEqual(numbers[0], numbers[1], "motion has a separate event number")
            for event in events {
                XCTAssertEqual(event.getIntegerValueField(.mouseEventButtonNumber), Int64(button.cg.rawValue))
                XCTAssertEqual(event.getIntegerValueField(CGEventField(rawValue: 7)!), 3)
                XCTAssertEqual(event.getIntegerValueField(CGEventField(rawValue: 91)!), Int64(window.id))
                XCTAssertEqual(event.getIntegerValueField(CGEventField(rawValue: 92)!), Int64(window.id))
                let bridged = try XCTUnwrap(NSEvent(cgEvent: event))
                XCTAssertEqual(bridged.windowNumber, Int(window.id))
                XCTAssertEqual(bridged.clickCount, Int(event.getIntegerValueField(.mouseEventClickState)))
            }
        }
    }

    @MainActor
    func testUnpacedProductionDragPostsItsWholeGestureWithoutWaitingBetweenEvents() async throws {
        let events = try makeDrag(from: CGPoint(x: 410, y: 349), to: CGPoint(x: 1410, y: 849), button: .left)
        var queuedTask: Task<Void, Never>?
        var yielded = false
        var posted: [CGEvent] = []
        var validations = 0

        try await MouseEventBurstDelivery.deliver(
            events: events,
            validate: { validations += 1 },
            post: {
                XCTAssertFalse(yielded, "coordinate gestures must not insert per-event sleeps")
                posted.append($0)
                if posted.count == 1 { queuedTask = Task { @MainActor in yielded = true } }
            },
            release: { _, _ in XCTFail("a completed drag has already released its button") }
        )
        XCTAssertEqual(posted.map(\.type), [.leftMouseDown, .leftMouseDragged, .leftMouseDragged, .leftMouseDragged, .leftMouseUp])
        XCTAssertEqual(validations, events.count)
        for (index, event) in posted.enumerated() {
            XCTAssertTrue(event === events[index], "delivery must preserve the production event objects")
        }
        await queuedTask?.value
        XCTAssertTrue(yielded)
    }

    func testCoordinateDragUsesTheTestedFactoryAndExplicitlyUnpacedDelivery() throws {
        // The executable delivery tests below the actuation boundary do not
        // resolve live windows. Guard the production caller's wiring as well,
        // so they cannot pass while drag still uses a different event builder
        // or accidentally inherits a future paced default.
        let source = try String(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/cu-helper/AXAction.swift"), encoding: .utf8)
        let start = try XCTUnwrap(source.range(of: "public static func drag("))
        let end = try XCTUnwrap(source.range(of: "static func dragEvents(", range: start.upperBound..<source.endIndex))
        let body = String(source[start.upperBound..<end.lowerBound])
        XCTAssertTrue(body.contains("let events = try dragEvents("))
        XCTAssertTrue(body.contains("try await postMouseBurst("))
        XCTAssertTrue(body.contains("pause: nil"), "coordinate drag must not insert an artificial per-event delay")
    }

    @MainActor
    func testCancellationAtEachProductionDragBoundaryReleasesOnlyTheLastPostedPoint() async throws {
        for button: MouseButton in [.left, .right, .middle] {
            let events = try makeDrag(from: CGPoint(x: 410, y: 349), to: CGPoint(x: 1410, y: 849), button: button)
            for cancelAfterPost in 0...events.count {
                var posted: [CGEvent] = []
                var releases: [(CGEvent, CGPoint)] = []
                let task = Task { @MainActor in
                    if cancelAfterPost == 0 { withUnsafeCurrentTask { $0?.cancel() } }
                    do {
                        try await MouseEventBurstDelivery.deliver(
                            events: events,
                            validate: {},
                            post: {
                                posted.append($0)
                                if posted.count == cancelAfterPost { withUnsafeCurrentTask { $0?.cancel() } }
                            },
                            release: { releases.append(($0, $1)) }
                        )
                        XCTFail("cancellation must stop the gesture, even after its final mouse-up")
                    } catch is CancellationError {
                        // The remaining tail must never be posted.
                    } catch {
                        XCTFail("unexpected error: \(error)")
                    }
                }
                await task.value
                XCTAssertEqual(posted.map(\.type), events.prefix(cancelAfterPost).map(\.type))
                let hasOutstandingDown = posted.contains { $0.type == button.down }
                    && !posted.contains { $0.type == button.up }
                XCTAssertEqual(releases.count, hasOutstandingDown ? 1 : 0)
                if let release = releases.first {
                    let down = try XCTUnwrap(posted.first { $0.type == button.down })
                    XCTAssertTrue(release.0 === down, "cleanup must retain the original press and its event number")
                    XCTAssertEqual(release.1, posted.last?.location, "cleanup must not jump to an unsent destination")
                }
            }
        }
    }

    @MainActor
    private func assertDrag(from: CGPoint, to: CGPoint, file: StaticString = #filePath, line: UInt = #line) throws {
        let midpoint = CGPoint(x: (from.x + to.x) / 2, y: (from.y + to.y) / 2)
        for button: MouseButton in [.left, .right, .middle] {
            let events = try makeDrag(from: from, to: to, button: button)
            XCTAssertEqual(events.map(\.type), [button.down, button.dragged, button.dragged, button.dragged, button.up], file: file, line: line)
            XCTAssertEqual(events.map(\.location), [from, from, midpoint, to, to], file: file, line: line)
        }
    }

    private var fixtureWindow: WindowGeometry.Window {
        WindowGeometry.Window(id: 123, bounds: CGRect(x: 200, y: 300, width: 800, height: 600), ownerPid: 456)
    }

    @MainActor
    private func makeDrag(from: CGPoint, to: CGPoint, button: MouseButton) throws -> [CGEvent] {
        let window = fixtureWindow
        return try AXAction.dragEvents(
            from: from, to: to, button: button,
            source: XCTUnwrap(CGEventSource(stateID: .privateState)), pid: window.ownerPid, window: window
        )
    }
}
