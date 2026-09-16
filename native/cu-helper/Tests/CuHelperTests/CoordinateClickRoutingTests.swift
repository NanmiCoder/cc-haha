import CoreGraphics
import XCTest

@testable import cc_haha_computer_use

final class CoordinateClickRoutingTests: XCTestCase {
    private enum Element { case canvasWindow, closeButton, contentButton }

    @MainActor
    func testCanvasWindowHitUsesExactCoordinateInsteadOfPressingItsCloseButton() async throws {
        let point = CGPoint(x: 1020, y: 710)
        var pressed: [Element] = []
        var clicked: [CGPoint] = []
        var settled = false
        let route = try await CoordinateClickRouting.click(
            point: point, preferAccessibility: true,
            hitTest: { _ in Element.canvasWindow },
            press: { element in
                pressed.append(element)
                return element == .closeButton ? "press" : nil
            },
            settle: { settled = true },
            syntheticClick: { clicked.append($0) }
        )
        XCTAssertEqual(pressed, [.canvasWindow], "a canvas click must never press the window's close control")
        XCTAssertEqual(clicked, [point])
        XCTAssertFalse(settled)
        XCTAssertEqual(route, "synthetic:point")
    }

    @MainActor
    func testExactActionableHitKeepsAccessibilityPath() async throws {
        var pressed: [Element] = []
        var settled = false
        let route = try await CoordinateClickRouting.click(
            point: CGPoint(x: 50, y: 60), preferAccessibility: true,
            hitTest: { _ in Element.contentButton },
            press: { pressed.append($0); return "press" },
            settle: { settled = true },
            syntheticClick: { _ in XCTFail("exact actionable hit needs no synthetic input") }
        )
        XCTAssertEqual(pressed, [.contentButton])
        XCTAssertTrue(settled)
        XCTAssertEqual(route, "ax:point:press")
    }

    @MainActor
    func testNonLeftClickSkipsAccessibilityAndPropagatesSyntheticFailure() async {
        enum Failure: Error { case refused }
        do {
            _ = try await CoordinateClickRouting.click(
                point: .zero, preferAccessibility: false,
                hitTest: { _ -> Element? in XCTFail("non-left button must skip AX"); return nil },
                press: { _ in XCTFail("must not press"); return nil },
                settle: { XCTFail("must not settle") },
                syntheticClick: { _ in throw Failure.refused }
            )
            XCTFail("synthetic target guards must remain authoritative")
        } catch {
            XCTAssertTrue(error is Failure)
        }
    }
}
