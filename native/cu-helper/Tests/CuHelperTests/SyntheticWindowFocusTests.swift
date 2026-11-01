import AppKit
import CoreGraphics
import XCTest

@testable import cc_haha_computer_use

/// Construct real events without posting them. Delivery and foreground
/// preservation remain real-machine acceptance requirements.
final class SyntheticWindowFocusTests: XCTestCase {
    func testKeyFocusReturnedSurvivesTheSignedSubtypeField() {
        XCTAssertEqual(SyntheticWindowFocus.Notification.keyFocusReturned.subtype, Int16(bitPattern: 0x8000))
        XCTAssertEqual(
            UInt16(bitPattern: SyntheticWindowFocus.Notification.keyFocusReturned.subtype),
            0x8000
        )
    }

    func testTheNotificationValuesMatchTheOnesRecoveredFromCodex() {
        XCTAssertEqual(SyntheticWindowFocus.Notification.appActivated.rawValue, 1)
        XCTAssertEqual(SyntheticWindowFocus.Notification.appDeactivated.rawValue, 2)
        XCTAssertEqual(SyntheticWindowFocus.Notification.lostKeyFocus.rawValue, 0x1000)
        XCTAssertEqual(SyntheticWindowFocus.Notification.keyFocusTaken.rawValue, 0x4000)
        XCTAssertEqual(SyntheticWindowFocus.Notification.keyFocusReturned.rawValue, 0x8000)
    }

    func testEachNotificationTravelsOnItsOwnCarrierType() {
        XCTAssertEqual(SyntheticWindowFocus.Notification.appActivated.carrierEventType, .appKitDefined)
        XCTAssertEqual(SyntheticWindowFocus.Notification.appDeactivated.carrierEventType, .appKitDefined)
        for notification: SyntheticWindowFocus.Notification in [.keyFocusReturned, .keyFocusTaken, .lostKeyFocus] {
            XCTAssertEqual(notification.carrierEventType?.rawValue, 21)
        }
    }

    func testTheKeyFocusCarrierSurvivesTheProductionAppKitBridge() throws {
        let event = try XCTUnwrap(SyntheticWindowFocus.notificationEvent(.keyFocusReturned))
        let native = try XCTUnwrap(NSEvent(cgEvent: event))
        XCTAssertEqual(native.type.rawValue, 21)
        XCTAssertEqual(native.subtype.rawValue, Int16(bitPattern: 0x8000))
        XCTAssertEqual(native.windowNumber, 0)
    }

    func testNotificationRetainsTheExplicitWindowAndFlags() throws {
        let event = try XCTUnwrap(SyntheticWindowFocus.notificationEvent(
            .appActivated, windowID: 42, flags: NSEvent.ModifierFlags(rawValue: 0xc0000)
        ))
        let native = try XCTUnwrap(NSEvent(cgEvent: event))
        XCTAssertEqual(native.type, .appKitDefined)
        XCTAssertEqual(native.subtype.rawValue, 1)
        XCTAssertEqual(native.windowNumber, 42)
        XCTAssertEqual(native.modifierFlags.rawValue, 0xc0000)
    }

    func testMissingWindowProducesOnlyTheGenericActivationNotification() throws {
        let events = try XCTUnwrap(SyntheticWindowFocus.activationEvents(window: nil))
        XCTAssertEqual(events.count, 1)
        let native = try XCTUnwrap(events.first.flatMap { NSEvent(cgEvent: $0) })
        XCTAssertEqual(native.type, .appKitDefined)
        XCTAssertEqual(native.subtype.rawValue, 1)
        XCTAssertEqual(native.windowNumber, 0)
        XCTAssertEqual(native.modifierFlags.rawValue, 0)
    }

    func testMissingActivationPointFallsBackToGenericActivationWithoutAClick() throws {
        let window = SyntheticWindowFocus.Window(
            id: 42, bounds: CGRect(x: 100, y: 200, width: 640, height: 480), activationPoint: nil
        )
        let events = try XCTUnwrap(SyntheticWindowFocus.activationEvents(window: window))
        XCTAssertEqual(events.count, 1)
        let native = try XCTUnwrap(events.first.flatMap { NSEvent(cgEvent: $0) })
        XCTAssertEqual(native.windowNumber, 0)
        XCTAssertEqual(native.modifierFlags.rawValue, 0)
    }

    func testExplicitAXActivationPointOutsideContentStillUsesWindowBoundActivation() throws {
        let window = SyntheticWindowFocus.Window(
            id: 42, bounds: CGRect(x: 100, y: 200, width: 640, height: 480),
            activationPoint: CGPoint(x: 80, y: 216)
        )
        let events = try XCTUnwrap(SyntheticWindowFocus.activationEvents(window: window))
        XCTAssertEqual(events.count, 3)
        XCTAssertEqual(events.dropFirst().map(\.location), [CGPoint(x: 80, y: 216), CGPoint(x: 80, y: 216)])
    }

    func testFailedAXQueriesUseGenericActivationEvenWhenAWindowWasResolved() throws {
        let bounds = CGRect(x: 100, y: 200, width: 640, height: 480)
        var point = CGPoint(x: 138, y: 216)
        let raw = try XCTUnwrap(AXValueCreate(.cgPoint, &point))
        let queries: [(AXError, CFTypeRef?)] = [
            (.attributeUnsupported, nil), (.noValue, nil), (.cannotComplete, raw), (.success, nil),
        ]
        for (error, value) in queries {
            let result = SyntheticWindowFocus.decodeActivationPoint(error: error, raw: value)
            let events = try XCTUnwrap(SyntheticWindowFocus.activationEvents(window: .init(
                id: 42, bounds: bounds, activationPoint: result
            )))
            XCTAssertEqual(events.count, 1)
            let native = try XCTUnwrap(NSEvent(cgEvent: events[0]))
            XCTAssertEqual(native.windowNumber, 0)
            XCTAssertEqual(native.modifierFlags.rawValue, 0)
        }
    }

    func testSuccessfulAXQueryDistinguishesExplicitOutsidePointsFromUnusableValues() throws {
        let bounds = CGRect(x: 100, y: 200, width: 640, height: 480)
        var outside = CGPoint(x: 80, y: 216)
        var nonfinite = CGPoint(x: CGFloat.nan, y: 216)
        let values: [CFTypeRef] = [
            "not a point" as CFString,
            try XCTUnwrap(AXValueCreate(.cgPoint, &outside)),
            try XCTUnwrap(AXValueCreate(.cgPoint, &nonfinite)),
        ]
        for (value, expectedCount) in zip(values, [1, 3, 1]) {
            let result = SyntheticWindowFocus.decodeActivationPoint(error: .success, raw: value)
            let events = try XCTUnwrap(SyntheticWindowFocus.activationEvents(window: .init(
                id: 42, bounds: bounds, activationPoint: result
            )))
            XCTAssertEqual(events.count, expectedCount)
            let native = try XCTUnwrap(NSEvent(cgEvent: events[0]))
            XCTAssertEqual(native.windowNumber, 42)
            XCTAssertEqual(native.modifierFlags.rawValue, 0xc0000)
        }
    }

    func testNeteaseAXActivationPointOutsideTheScreenStillPrimesOnlyItsProvenWindow() throws {
        // Captured from NetEase on macOS: its AX window supplies this point,
        // despite it being outside the content rectangle and screen. Codex
        // retains it in its PID/window-bound activation click, without moving
        // the user's physical pointer or guessing an in-window UI control.
        let bounds = CGRect(x: 332, y: 199, width: 1065, height: 752)
        var point = CGPoint(x: -1, y: 1118)
        let raw = try XCTUnwrap(AXValueCreate(.cgPoint, &point))
        let result = SyntheticWindowFocus.decodeActivationPoint(error: .success, raw: raw)
        let events = try XCTUnwrap(SyntheticWindowFocus.activationEvents(window: .init(
            id: 42, bounds: bounds, activationPoint: result
        )))
        XCTAssertEqual(events.count, 3)
        XCTAssertEqual(events.dropFirst().map(\.location), [point, point])
        for event in events.dropFirst() {
            XCTAssertEqual(event.getIntegerValueField(CGEventField(rawValue: 91)!), 42)
            XCTAssertEqual(event.getIntegerValueField(CGEventField(rawValue: 92)!), 42)
            XCTAssertEqual(event.getIntegerValueField(.mouseEventClickState), 1)
        }
    }

    func testSuccessfulAXPointQueryDrivesTheWindowBoundActivationBurst() throws {
        let bounds = CGRect(x: 100, y: 200, width: 640, height: 480)
        var point = CGPoint(x: 138, y: 216)
        let raw = try XCTUnwrap(AXValueCreate(.cgPoint, &point))
        let result = SyntheticWindowFocus.decodeActivationPoint(error: .success, raw: raw)
        let events = try XCTUnwrap(SyntheticWindowFocus.activationEvents(window: .init(
            id: 42, bounds: bounds, activationPoint: result
        )))
        XCTAssertEqual(events.count, 3)
        XCTAssertEqual(events.map { NSEvent(cgEvent: $0)?.windowNumber }, [42, 42, 42])
        XCTAssertEqual(Array(events.dropFirst()).map(\.location), [point, point])
    }

    func testActivationClickUsesOnlyTheSuppliedAXPointAndWindow() throws {
        let point = CGPoint(x: 138, y: 216)
        let window = SyntheticWindowFocus.Window(
            id: 42, bounds: CGRect(x: 100, y: 200, width: 640, height: 480), activationPoint: point
        )
        let events = try XCTUnwrap(SyntheticWindowFocus.activationEvents(window: window))
        XCTAssertEqual(events.count, 3)
        let native = try events.map { try XCTUnwrap(NSEvent(cgEvent: $0)) }
        XCTAssertEqual(native.map(\.type), [.appKitDefined, .leftMouseDown, .leftMouseUp])
        XCTAssertEqual(native.map(\.windowNumber), [42, 42, 42])
        for event in events.dropFirst() {
            XCTAssertEqual(event.location, point)
            XCTAssertEqual(event.flags.rawValue, 0)
            XCTAssertEqual(event.getIntegerValueField(.mouseEventButtonNumber), 0)
            XCTAssertEqual(event.getIntegerValueField(.mouseEventSubtype), 3)
            // The reference clears CG field 3 (left button), not field 1
            // (click count). Activation remains a genuine single click.
            XCTAssertEqual(event.getIntegerValueField(.mouseEventClickState), 1)
            XCTAssertEqual(try XCTUnwrap(NSEvent(cgEvent: event)).clickCount, 1)
            XCTAssertEqual(event.getIntegerValueField(CGEventField(rawValue: 91)!), 42)
            XCTAssertEqual(event.getIntegerValueField(CGEventField(rawValue: 92)!), 42)
        }
    }

    func testAnInvalidPidIsRefusedRatherThanBroadcast() {
        XCTAssertFalse(SyntheticWindowFocus.post(.keyFocusReturned, to: 0))
        XCTAssertFalse(SyntheticWindowFocus.post(.keyFocusReturned, to: -1))
    }

    func testTeardownWithdrawsFocusBeforeActivationBelief() throws {
        let source = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent("Sources/cu-helper/SyntheticWindowFocus.swift"),
            encoding: .utf8
        )
        let body = try XCTUnwrap(source.range(of: "static func relinquishAll").map {
            String(source[$0.lowerBound...].prefix(1_000))
        })
        let lostFocus = try XCTUnwrap(body.range(of: "post(.lostKeyFocus"))
        let deactivated = try XCTUnwrap(body.range(of: "post(.appDeactivated"))
        XCTAssertLessThan(lostFocus.lowerBound, deactivated.lowerBound)
    }
}

final class InputAcceptanceContractTests: XCTestCase {
    private func source(_ name: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/cu-helper")
        return try String(contentsOf: root.appendingPathComponent(name), encoding: .utf8)
    }

    func testEveryInputPathEnsuresTheTargetWillAcceptIt() throws {
        let axAction = try source("AXAction.swift")
        let preparation = try XCTUnwrap(axAction.range(of: "private static func ensureTargetAcceptsInput").map {
            String(axAction[$0.lowerBound...].prefix(700))
        })
        XCTAssertTrue(preparation.contains("try await SyntheticWindowFocus.prepareInput"))
        for entry in ["clickPoint", "typeText", "pressKey"] {
            let body = try XCTUnwrap(
                axAction.range(of: "public static func \(entry)").map {
                    String(axAction[$0.lowerBound...].prefix(1200))
                }, "\(entry) is missing"
            )
            XCTAssertTrue(
                body.contains("try await ensureTargetAcceptsInput"),
                "\(entry) must await target acceptance before acting"
            )
        }
    }

    func testNoInputPathTakesTheUsersForeground() throws {
        // Delivery cannot be proved offline; prevent reintroducing the known
        // foreground-stealing escape hatch into either actual input path.
        for file in ["AXAction.swift", "Injection.swift"] {
            let body = try source(file)
                .split(separator: "\n", omittingEmptySubsequences: false)
                .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
                .joined(separator: "\n")
            XCTAssertFalse(body.contains("WindowKeyFocus.grant"), "\(file) must preserve the user's foreground")
        }
    }

    func testTheDecomposedMousePathStillPreparesItsTarget() throws {
        let injection = try source("Injection.swift")
        let focus = try XCTUnwrap(injection.range(of: "private static func focusForClick").map {
            String(injection[$0.lowerBound...].prefix(600))
        })
        XCTAssertTrue(
            focus.contains("SyntheticWindowFocus.prepareInput"),
            "decomposed mouse commands must await target acceptance too"
        )
    }

    func testAHiddenAppGetsTheAppLevelActivation() {
        let window = SyntheticWindowFocus.Window(
            id: 42, bounds: CGRect(x: 0, y: 0, width: 800, height: 600),
            activationPoint: .some(CGPoint(x: 10, y: 10))
        )
        XCTAssertNil(SyntheticWindowFocus.activationWindow(window, appIsHidden: true))
        XCTAssertEqual(SyntheticWindowFocus.activationWindow(window, appIsHidden: false), window)
    }
}
