import AppKit
import XCTest
@testable import cc_haha_computer_use

final class NativeScrollTests: XCTestCase {
    func testSecondaryPageActionsChooseOfficialAxisAndButtonSubrole() throws {
        for (action, axis, subrole) in [
            ("AXScrollUpByPage", "AXVerticalScrollBar", "AXDecrementPage"),
            ("AXScrollDownByPage", "AXVerticalScrollBar", "AXIncrementPage"),
            ("AXScrollLeftByPage", "AXHorizontalScrollBar", "AXDecrementPage"),
            ("AXScrollRightByPage", "AXHorizontalScrollBar", "AXIncrementPage"),
        ] {
            let result = try XCTUnwrap(NativeScroll.pageNavigation(action: action))
            XCTAssertEqual(result.axisAttribute, axis)
            XCTAssertEqual(result.buttonSubrole, subrole)
        }
        XCTAssertNil(NativeScroll.pageNavigation(action: "AXPress"))
    }

    func testFractionalPagesUseAddressedFrameAndRoundPixelDeltas() throws {
        let element = CGSize(width: 720, height: 210)
        XCTAssertEqual(try NativeScroll.delta(direction: "down", pages: 0.5, frameSize: element).y, -105)
        XCTAssertEqual(try NativeScroll.delta(direction: "down", pages: 1.5, frameSize: element).y, -315)
        XCTAssertEqual(try NativeScroll.delta(direction: "down", pages: 0.123, frameSize: element).y, -26)
        XCTAssertEqual(try NativeScroll.delta(direction: "up", pages: 0.5, frameSize: element).y, 105)
        XCTAssertEqual(try NativeScroll.delta(direction: "right", pages: 0.5, frameSize: element).x, -360)
        XCTAssertEqual(try NativeScroll.delta(direction: "left", pages: 1.5, frameSize: element).x, 1080)
        XCTAssertEqual(try NativeScroll.delta(direction: "down", pages: 0.5, frameSize: CGSize(width: 760, height: 552)).y, -276)
        for pages in [0, -1, Double.infinity, Double.nan] {
            XCTAssertThrowsError(try NativeScroll.delta(direction: "down", pages: pages, frameSize: element))
        }
    }

    func testPreciseScrollEventCarriesBothAxesAndTargetWindow() throws {
        let source = try XCTUnwrap(CGEventSource(stateID: .privateState))
        let window = WindowGeometry.Window(id: 71, bounds: CGRect(x: 100, y: 200, width: 760, height: 552), ownerPid: 123)
        let event = try XCTUnwrap(WindowTargetedEvent.makeScrollEvent(source: source, point: CGPoint(x: 300, y: 400), deltaX: -360, deltaY: -105, window: window))
        let native = try XCTUnwrap(NSEvent(cgEvent: event))
        XCTAssertTrue(native.hasPreciseScrollingDeltas)
        XCTAssertEqual(native.scrollingDeltaX, -360)
        XCTAssertEqual(native.scrollingDeltaY, -105)
        XCTAssertEqual(native.windowNumber, 71)
    }
}
