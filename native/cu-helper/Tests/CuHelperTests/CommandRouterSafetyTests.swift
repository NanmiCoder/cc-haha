import XCTest
@testable import cc_haha_computer_use

@MainActor
final class CommandRouterSafetyTests: XCTestCase {
    private let processA = AXTreeProcessIdentity(
        bundleID: "com.example.a",
        executablePath: "/Applications/A.app/Contents/MacOS/A",
        launchTime: 100
    )

    private let processB = AXTreeProcessIdentity(
        bundleID: "com.example.a",
        executablePath: "/Applications/A.app/Contents/MacOS/A",
        launchTime: 200
    )

    func testRoundedScreenshotDimensionsPreserveOfficialUniformCoordinateScale() throws {
        defer { CommandRouter.clearShotTransformsForTesting() }
        CommandRouter.recordShotTransform(
            pid: 77, originX: 100, originY: 200,
            pointWidth: 1398, pointHeight: 769,
            imageWidth: 1397, imageHeight: 768,
            processIdentity: processA, windowID: 17,
            pixelsPerPoint: 768.0 / 769.0
        )
        let point = try CommandRouter.toGlobalPoint(
            x: 300, y: 180, pid: 77,
            currentProcessIdentity: processA, currentWindowID: 17
        )
        // Actual official native receiver, 1398×769 points → 1397×768 JPEG.
        // Both axes use the original fit, before the pixel buffer's ceil.
        XCTAssertEqual(point.x, 400.390625, accuracy: 0.000001)
        XCTAssertEqual(point.y, 380.234375, accuracy: 0.000001)
    }

    func testInvalidUniformCaptureScaleCannotPublishACoordinateTransform() throws {
        defer { CommandRouter.clearShotTransformsForTesting() }
        for scale in [0, -1, Double.nan, Double.infinity] {
            CommandRouter.recordShotTransform(
                pid: 77, originX: 100, originY: 200,
                pointWidth: 1398, pointHeight: 769,
                imageWidth: 1397, imageHeight: 768,
                processIdentity: processA, windowID: 17,
                pixelsPerPoint: scale
            )
            XCTAssertThrowsError(try CommandRouter.toGlobalPoint(
                x: 300, y: 180, pid: 77,
                currentProcessIdentity: processA, currentWindowID: 17
            )) { XCTAssertEqual(($0 as? CUError)?.code, "stale_snapshot") }
        }
    }

    func testHeadlessMouseDownAndMouseUpRequireDaemon() async throws {
        let monitor = PhysicalInputEpochMonitor(counterReader: { _ in 0 })
        _ = monitor.startAndWait()
        defer { monitor.stop() }
        let router = CommandRouter(
            cursor: VirtualCursor(headless: true),
            capabilities: Capabilities(headless: true),
            inputMonitor: monitor
        )

        for command in ["mouse_down", "mouse_up"] {
            do {
                _ = try await router.handle(
                    cmd: command,
                    payload: .object([:])
                )
                XCTFail("expected daemon_required for \(command)")
            } catch let error as CUError {
                XCTAssertEqual(error.code, "daemon_required")
            }
        }
    }

    func testInputMonitorStateSerializesCountersAsDecimalStrings() async throws {
        let monitor = PhysicalInputEpochMonitor(counterReader: { _ in 0 })
        let router = CommandRouter(
            cursor: VirtualCursor(headless: true),
            capabilities: Capabilities(headless: true),
            inputMonitor: monitor
        )

        let result = try await router.handle(
            cmd: "input_monitor_state",
            payload: .object([:])
        )

        for key in ["epoch", "continuityGeneration"] {
            guard let value = result[key]?.asString else {
                return XCTFail("expected decimal string for \(key)")
            }
            XCTAssertNotNil(UInt64(value), "expected UInt64 decimal for \(key)")
        }
    }

    func testHeldInputStateIsReadOnlyAndStartsEmpty() async throws {
        let monitor = PhysicalInputEpochMonitor(counterReader: { _ in 0 })
        let router = CommandRouter(
            cursor: VirtualCursor(headless: true),
            capabilities: Capabilities(headless: true),
            inputMonitor: monitor
        )

        let first = try await router.handle(
            cmd: "held_input_state",
            payload: .object([:])
        )
        let second = try await router.handle(
            cmd: "held_input_state",
            payload: .object([:])
        )

        XCTAssertEqual(first, .object([
            "keys": .array([]),
            "buttons": .array([]),
        ]))
        XCTAssertEqual(second, first)
    }

    func testSessionResetClearsScreenshotCoordinateTransforms() throws {
        let monitor = PhysicalInputEpochMonitor(counterReader: { _ in 0 })
        let router = CommandRouter(
            cursor: VirtualCursor(headless: true),
            capabilities: Capabilities(headless: true),
            inputMonitor: monitor
        )
        CommandRouter.recordShotTransform(
            pid: 77,
            originX: 100,
            originY: 200,
            pointWidth: 500,
            pointHeight: 400,
            imageWidth: 1_000,
            imageHeight: 800,
            processIdentity: processA,
            windowID: 17
        )

        XCTAssertEqual(
            try CommandRouter.toGlobalPoint(
                x: 20,
                y: 40,
                pid: 77,
                currentProcessIdentity: processA,
                currentWindowID: 17
            ),
            CGPoint(x: 110, y: 220)
        )

        router.resetSessionState()

        XCTAssertThrowsError(try CommandRouter.toGlobalPoint(
            x: 20,
            y: 40,
            pid: 77,
            currentProcessIdentity: processA,
            currentWindowID: 17
        )) {
            XCTAssertEqual(($0 as? CUError)?.code, "stale_snapshot")
        }
    }

    func testTurnStateResetPreservesTheDaemonLifetimeWindowCaptureProvider() {
        let monitor = PhysicalInputEpochMonitor(counterReader: { _ in 0 })
        let provider = WindowCaptureProviderSpy()
        let router = CommandRouter(
            cursor: VirtualCursor(headless: true),
            capabilities: Capabilities(headless: true),
            inputMonitor: monitor,
            windowCaptureProvider: provider
        )

        router.resetSessionState()

        XCTAssertEqual(provider.invalidateCount, 0)
        router.invalidateWindowCaptureStream()
        XCTAssertEqual(provider.invalidateCount, 1)
    }

    func testSessionResetClearsThePreviousMutationSettleDeadline() async throws {
        let monitor = PhysicalInputEpochMonitor(counterReader: { _ in 0 })
        let router = CommandRouter(
            cursor: VirtualCursor(headless: true),
            capabilities: Capabilities(headless: true),
            inputMonitor: monitor
        )
        let process = try XCTUnwrap(ProvenProcessTarget(pid: 77, identity: processA))
        let lease = try ForegroundLease.acquire(target: process, runtime: ForegroundLeaseRuntime(
            inputSnapshot: { PhysicalInputEpochSnapshot(epoch: 0, available: true) },
            frontmostTarget: { nil },
            currentIdentity: { _ in self.processA },
            activate: { _ in XCTFail("must not activate"); return false },
            verifyFrontmost: { _ in XCTFail("must not activate"); return false }
        ))
        _ = try await ForegroundMutationRunner.run(lease: lease) { true }
        XCTAssertNotNil(MutationClock.lastMutation())
        router.resetSessionState()
        XCTAssertNil(MutationClock.lastMutation())
    }

    func testDiscardedWindowSnapshotForcesTheRetryToReturnAFullTree() {
        XCTAssertFalse(CommandRouter.effectiveDisableDiff(
            requested: false,
            forceFullSnapshot: false
        ))
        XCTAssertTrue(CommandRouter.effectiveDisableDiff(
            requested: false,
            forceFullSnapshot: true
        ))
        XCTAssertTrue(CommandRouter.effectiveDisableDiff(
            requested: true,
            forceFullSnapshot: false
        ))
    }

    func testCoordinateTransformNeverFallsBackAcrossApps() {
        CommandRouter.clearShotTransformsForTesting()
        CommandRouter.recordShotTransform(
            pid: 77,
            originX: 100,
            originY: 200,
            pointWidth: 500,
            pointHeight: 400,
            imageWidth: 1_000,
            imageHeight: 800,
            processIdentity: processA,
            windowID: 17
        )

        XCTAssertThrowsError(try CommandRouter.toGlobalPoint(
            x: 20,
            y: 40,
            pid: 88,
            currentProcessIdentity: processA,
            currentWindowID: 17
        )) {
            XCTAssertEqual(($0 as? CUError)?.code, "stale_snapshot")
        }
    }

    func testCoordinateTransformRejectsProcessAndWindowChanges() {
        CommandRouter.clearShotTransformsForTesting()
        CommandRouter.recordShotTransform(
            pid: 77,
            originX: 100,
            originY: 200,
            pointWidth: 500,
            pointHeight: 400,
            imageWidth: 1_000,
            imageHeight: 800,
            processIdentity: processA,
            windowID: 17
        )

        XCTAssertThrowsError(try CommandRouter.toGlobalPoint(
            x: 20,
            y: 40,
            pid: 77,
            currentProcessIdentity: processB,
            currentWindowID: 17
        )) {
            XCTAssertEqual(($0 as? CUError)?.code, "stale_process")
        }
        CommandRouter.recordShotTransform(
            pid: 77,
            originX: 100,
            originY: 200,
            pointWidth: 500,
            pointHeight: 400,
            imageWidth: 1_000,
            imageHeight: 800,
            processIdentity: processA,
            windowID: 17
        )
        XCTAssertThrowsError(try CommandRouter.toGlobalPoint(
            x: 20,
            y: 40,
            pid: 77,
            currentProcessIdentity: processA,
            currentWindowID: 18
        )) {
            XCTAssertEqual(($0 as? CUError)?.code, "target_window_changed")
        }
    }

    func testCoordinateTransformRejectsPointsOutsideLatestScreenshot() {
        CommandRouter.clearShotTransformsForTesting()
        CommandRouter.recordShotTransform(
            pid: 77,
            originX: 100,
            originY: 200,
            pointWidth: 500,
            pointHeight: 400,
            imageWidth: 1_000,
            imageHeight: 800,
            processIdentity: processA,
            windowID: 17
        )

        for point in [
            CGPoint(x: -1, y: 0),
            CGPoint(x: 0, y: -1),
            CGPoint(x: 1_000, y: 0),
            CGPoint(x: 0, y: 800),
        ] {
            XCTAssertThrowsError(try CommandRouter.toGlobalPoint(
                x: point.x,
                y: point.y,
                pid: 77,
                currentProcessIdentity: processA,
                currentWindowID: 17
            )) {
                XCTAssertEqual(($0 as? CUError)?.code, "bad_payload")
            }
        }

        XCTAssertNoThrow(try CommandRouter.toGlobalPoint(
            x: 999.999,
            y: 799.999,
            pid: 77,
            currentProcessIdentity: processA,
            currentWindowID: 17
        ))
    }

    func testEverySemanticCommandExceptListAppsRequiresExplicitTarget() async throws {
        let monitor = PhysicalInputEpochMonitor(counterReader: { _ in 0 })
        let router = CommandRouter(
            cursor: VirtualCursor(headless: true),
            capabilities: Capabilities(headless: true),
            inputMonitor: monitor
        )
        let cases: [(String, JSONValue)] = [
            ("resolve_app_target", .object([:])),
            ("get_app_state", .object([:])),
            ("click", .object(["x": .int(1), "y": .int(1)])),
            ("set_value", .object(["index": .string("g1:0"), "value": .string("x")])),
            ("select_text", .object(["index": .string("g1:0"), "text": .string("x")])),
            ("perform_secondary_action", .object(["index": .string("g1:0"), "action": .string("Raise")])),
            ("scroll", .object(["x": .int(1), "y": .int(1), "direction": .string("down")])),
            ("type_text", .object(["text": .string("x")])),
            ("press_key", .object(["key": .string("Return")])),
            ("drag", .object([
                "from": .object(["x": .int(1), "y": .int(1)]),
                "to": .object(["x": .int(2), "y": .int(2)]),
            ])),
        ]

        for (command, payload) in cases {
            do {
                _ = try await router.handle(cmd: command, payload: payload)
                XCTFail("expected explicit-target failure for \(command)")
            } catch let error as CUError {
                XCTAssertEqual(error.code, "no_target", command)
            }
        }

        _ = try await router.handle(cmd: "list_apps", payload: .object([:]))
    }

    func testRuntimeArgumentBoundsFailClosed() throws {
        XCTAssertEqual(try CommandRouter.parseClickCount(.object([:])), 1)
        XCTAssertEqual(try CommandRouter.parseClickCount(.object(["click_count": .int(3)])), 3)
        for invalid in [JSONValue.int(0), .int(4), .double(1.5), .bool(true), .string("2")] {
            XCTAssertThrowsError(try CommandRouter.parseClickCount(.object([
                "click_count": invalid,
            ]))) {
                XCTAssertEqual(($0 as? CUError)?.code, "bad_payload")
            }
        }

        XCTAssertEqual(try CommandRouter.parsePages(.object([:])), 1)
        XCTAssertEqual(try CommandRouter.parsePages(.object(["pages": .double(0.5)])), 0.5)
        for invalid in [
            JSONValue.int(0), .int(11), .double(.infinity), .bool(true), .string("2"),
        ] {
            XCTAssertThrowsError(try CommandRouter.parsePages(.object([
                "pages": invalid,
            ]))) {
                XCTAssertEqual(($0 as? CUError)?.code, "bad_payload")
            }
        }

        for valid in ["left", "middle", "right", "back", "forward"] {
            XCTAssertEqual(
                try CommandRouter.parseMouseButton(.object([
                    "mouse_button": .string(valid),
                ])).rawValue,
                valid
            )
        }
        for invalid in ["banana", "", "4"] {
            XCTAssertThrowsError(try CommandRouter.parseMouseButton(.object([
                "mouse_button": .string(invalid),
            ]))) {
                XCTAssertEqual(($0 as? CUError)?.code, "bad_payload")
            }
        }
    }

    func testFocusTargetedActionsRequireMatchingSnapshotProcessLifetime() throws {
        XCTAssertThrowsError(try SnapshotProcessGuard.validate(
            pid: 77,
            snapshot: nil,
            current: processA,
            expected: nil
        )) {
            XCTAssertEqual(($0 as? CUError)?.code, "stale_snapshot")
        }

        let snapshot = AXTreeSnapshotEvidence(
            processIdentity: processA,
            keyWindowID: 17
        )
        XCTAssertNoThrow(try SnapshotProcessGuard.validate(
            pid: 77,
            snapshot: snapshot,
            current: processA,
            expected: processA
        ))
        for (current, expected) in [
            (processB, Optional<AXTreeProcessIdentity>.none),
            (processA, Optional(processB)),
        ] {
            XCTAssertThrowsError(try SnapshotProcessGuard.validate(
                pid: 77,
                snapshot: snapshot,
                current: current,
                expected: expected
            )) {
                XCTAssertEqual(($0 as? CUError)?.code, "stale_process")
            }
        }
    }

    func testExpectedProcessIdentityWireIsStrictAndIncludesPID() throws {
        let expected = try CommandRouter.expectedProcessTarget(.object([
            "expectedProcessIdentity": .object([
                "pid": .int(77),
                "bundleId": .string("com.example.a"),
                "executablePath": .string("/Applications/A.app/Contents/MacOS/A"),
                "launchTime": .double(100),
            ]),
        ]))
        XCTAssertEqual(expected?.pid, 77)
        XCTAssertEqual(expected?.identity, processA)

        for invalidLaunchTime in [
            JSONValue.bool(true),
            .string("100"),
            .double(.infinity),
        ] {
            XCTAssertThrowsError(try CommandRouter.expectedProcessTarget(.object([
                "expectedProcessIdentity": .object([
                    "pid": .int(77),
                    "bundleId": .string("com.example.a"),
                    "executablePath": .string("/Applications/A.app/Contents/MacOS/A"),
                    "launchTime": invalidLaunchTime,
                ]),
            ]))) {
                XCTAssertEqual(($0 as? CUError)?.code, "bad_payload")
            }
        }
    }
}

@MainActor
private final class WindowCaptureProviderSpy: WindowCaptureProviding {
    private(set) var invalidateCount = 0

    func windowShot(
        pid: pid_t,
        processIdentity: AXTreeProcessIdentity,
        preferredWindowID: CGWindowID?,
        scale: Double?,
        newerThanUptime: TimeInterval?
    ) async -> WindowShot? {
        nil
    }

    func invalidate() {
        invalidateCount += 1
    }
}
