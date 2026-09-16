import CoreMedia
import ScreenCaptureKit
import XCTest

@testable import cc_haha_computer_use

@MainActor
final class WindowCaptureStreamTests: XCTestCase {
    func testDiagnosticsObserveTheRealSnapshotLifecycleWithoutReadingPixelsOrStartingStreams() async throws {
        let target = makeTarget(windowID: 90)
        let factory = FakeWindowCaptureStreamFactory { _, _ in }
        var captures = 0
        let manager = WindowCaptureStreamManager(factory: factory, takeSnapshot: { target, _ in
            captures += 1
            return self.makeSnapshot(target, pixels: "snapshot")
        })

        let idle = manager.diagnostic(now: 12)
        XCTAssertEqual(idle.generation, 0)
        XCTAssertNil(idle.activeKey)
        XCTAssertNil(idle.hasFailed)
        XCTAssertNil(idle.sampleCount)
        XCTAssertTrue(factory.sources.isEmpty)

        _ = await manager.captureSnapshot(for: target, scale: 0.5)
        let source = try XCTUnwrap(factory.sources.first)
        let started = manager.diagnostic(now: 12)
        XCTAssertEqual(started.activeKey, target.key)
        XCTAssertNil(started.startingKey)
        XCTAssertEqual(started.hasFailed, false)
        XCTAssertEqual(started.sampleCount, 0)
        XCTAssertNil(started.latestFrameSequence, "Successful start is not proof of a generated frame")
        XCTAssertNil(started.latestFrameAgeSeconds)

        source.publish(makeFrame(for: target.key, sequence: 1, uptime: 10, byte: 7))
        source.publishStatus(.idle, uptime: 11)
        let idleFrame = manager.diagnostic(now: 12)
        XCTAssertEqual(idleFrame.generation, started.generation)
        XCTAssertEqual(idleFrame.latestFrameSequence, 1)
        XCTAssertEqual(idleFrame.latestFrameAgeSeconds, 2)
        XCTAssertEqual(idleFrame.sampleCount, 2)
        XCTAssertEqual(idleFrame.latestSampleStatus, SCFrameStatus.idle.rawValue)
        XCTAssertEqual(idleFrame.latestSampleAgeSeconds, 1)

        source.publish(makeFrame(for: target.key, sequence: 2, uptime: 13, byte: 7))
        let refreshed = manager.diagnostic(now: 14)
        XCTAssertEqual(refreshed.latestFrameSequence, 2, "Identical pixels can still be a new frame")
        XCTAssertEqual(refreshed.latestFrameAgeSeconds, 1)
        XCTAssertEqual(refreshed.sampleCount, 3)
        XCTAssertEqual(refreshed.latestSampleStatus, SCFrameStatus.complete.rawValue)
        XCTAssertGreaterThan(source.latestReadCount, 0)
        XCTAssertEqual(source.startCount, 1)
        XCTAssertEqual(source.retireCount, 0)
        XCTAssertEqual(captures, 0, "A source without a pixel frame must not take a screenshot")
    }

    func testDiagnosticFailureAndInvalidationDoNotRebuildOrExposeRetiredFrames() async throws {
        let target = makeTarget(windowID: 91)
        let factory = FakeWindowCaptureStreamFactory { source, _ in
            source.startFrame = makeFrame(for: source.targetKey, sequence: 1, uptime: 10, byte: 1)
        }
        let manager = WindowCaptureStreamManager(factory: factory, takeSnapshot: { target, _ in
            self.makeSnapshot(target, pixels: "snapshot")
        })
        _ = await manager.captureSnapshot(for: target, scale: 0.5)
        let source = try XCTUnwrap(factory.sources.first)
        let activeGeneration = manager.diagnostic(now: 12).generation
        source.failed = true
        XCTAssertEqual(manager.diagnostic(now: 12).hasFailed, true)
        XCTAssertEqual(factory.sources.count, 1)
        XCTAssertEqual(source.retireCount, 0)

        manager.invalidate()
        source.publish(makeFrame(for: target.key, sequence: 2, uptime: 13, byte: 2))
        let retired = manager.diagnostic(now: 14)
        XCTAssertGreaterThan(retired.generation, activeGeneration)
        XCTAssertNil(retired.activeKey)
        XCTAssertNil(retired.startingKey)
        XCTAssertNil(retired.hasFailed)
        XCTAssertNil(retired.latestFrameSequence)
        XCTAssertNil(retired.latestFrameAgeSeconds)
        XCTAssertNil(retired.latestSampleStatus)
        XCTAssertGreaterThan(source.latestReadCount, 0)
        XCTAssertEqual(source.retireCount, 1)
    }

    func testMailboxDiagnosticRecordsNonPixelStatusesWithoutAdvancingFrameAndIgnoresRetiredCallbacks() {
        let mailbox = WindowCaptureStreamMailbox()
        mailbox.recordSampleStatus(.started, receivedUptime: 10)
        mailbox.recordSampleStatus(.suspended, receivedUptime: 11)
        let suspended = mailbox.sampleDiagnostic()
        XCTAssertEqual(suspended.sampleCount, 2)
        XCTAssertEqual(suspended.latestSampleStatus, SCFrameStatus.suspended.rawValue)
        XCTAssertEqual(suspended.latestSampleReceivedUptime, 11)
        XCTAssertNil(suspended.latestFrameSequence)
        XCTAssertFalse(suspended.hasFailed)

        mailbox.invalidate()
        mailbox.recordSampleStatus(.complete, receivedUptime: 12)
        XCTAssertEqual(mailbox.sampleDiagnostic(), suspended)
    }

    func testOnDemandScreenshotUsesOnlyTheTargetWindowBounds() {
        let config = Capture.makeWindowShotConfiguration(width: 1061, height: 752)
        XCTAssertEqual(config.width, 1061)
        XCTAssertEqual(config.height, 752)
        XCTAssertTrue(config.ignoreShadowsSingleWindow)
        XCTAssertTrue(config.ignoreShadowsDisplay)
        if #available(macOS 14.2, *) {
            XCTAssertFalse(config.includeChildWindows, "A sharing child must not expand the screenshot beyond its click transform")
        }
        XCTAssertTrue(config.scalesToFit)
        XCTAssertTrue(config.preservesAspectRatio)
        XCTAssertFalse(config.showsCursor)
    }

    func testEveryStateReadTakesANewSnapshotWhileReusingTheLongLivedStream() async throws {
        let target = makeTarget(windowID: 84)
        let factory = FakeWindowCaptureStreamFactory { source, _ in
            source.startFrame = makeFrame(
                for: source.targetKey,
                sequence: 1,
                uptime: 10,
                byte: 7
            )
        }
        var captures = 0
        let manager = WindowCaptureStreamManager(factory: factory, takeSnapshot: { target, _ in
            captures += 1
            return self.makeSnapshot(target, pixels: "read-\(captures)")
        })
        let first = await manager.captureSnapshot(for: target, scale: 0.5)
        let second = await manager.captureSnapshot(for: target, scale: 0.5)
        XCTAssertEqual(first?.base64, "read-1")
        XCTAssertEqual(second?.base64, "read-2")
        XCTAssertEqual(captures, 2)
        XCTAssertEqual(factory.sources.count, 1)
        XCTAssertEqual(factory.sources[0].startCount, 1)
        XCTAssertGreaterThan(factory.sources[0].latestReadCount, 0)
    }

    func testPostMutationSnapshotConsumesFreshStreamWatermarkBeforeSkyshot() async throws {
        let target = makeTarget(windowID: 87)
        let factory = FakeWindowCaptureStreamFactory { source, _ in
            source.startFrame = makeFrame(
                for: source.targetKey,
                sequence: 1,
                uptime: 12,
                byte: 7
            )
        }
        var captures = 0
        let manager = WindowCaptureStreamManager(factory: factory, takeSnapshot: { target, _ in
            captures += 1
            return self.makeSnapshot(target, pixels: "fresh-skyshot")
        })

        let shot = await manager.captureSnapshot(
            for: target,
            scale: 0.5,
            newerThanUptime: 11
        )

        XCTAssertEqual(shot?.base64, "fresh-skyshot")
        XCTAssertEqual(captures, 1)
        XCTAssertEqual(factory.sources.count, 1)
        XCTAssertGreaterThan(factory.sources[0].latestReadCount, 0)
        XCTAssertEqual(factory.sources[0].retireCount, 0)
    }

    func testPostMutationSnapshotFailsClosedWhenNoFreshStreamFrameArrives() async {
        let target = makeTarget(windowID: 88)
        let factory = FakeWindowCaptureStreamFactory { source, _ in
            source.startFrame = makeFrame(
                for: source.targetKey,
                sequence: 1,
                uptime: 10,
                byte: 7
            )
        }
        var captures = 0
        let manager = WindowCaptureStreamManager(
            factory: factory,
            frameWaitAttempts: 0,
            frameWaitNanoseconds: 0,
            takeSnapshot: { target, _ in
                captures += 1
                return self.makeSnapshot(target, pixels: "must-not-run")
            }
        )

        let shot = await manager.captureSnapshot(
            for: target,
            scale: 0.5,
            newerThanUptime: 11
        )

        XCTAssertNil(shot)
        XCTAssertEqual(captures, 0)
        XCTAssertEqual(factory.sources.count, 2, "One bounded stream rebuild is attempted")
        XCTAssertEqual(factory.sources[0].retireCount, 1)
    }

    func testSnapshotFailureDoesNotFallBackToCachedStreamPixels() async {
        let target = makeTarget(windowID: 85)
        let factory = FakeWindowCaptureStreamFactory { source, _ in
            source.startFrame = makeFrame(for: source.targetKey, sequence: 1, uptime: 10, byte: 7)
        }
        let manager = WindowCaptureStreamManager(factory: factory, takeSnapshot: { _, _ in nil })
        let shot = await manager.captureSnapshot(for: target, scale: 0.5)
        XCTAssertNil(shot)
        XCTAssertGreaterThan(factory.sources[0].latestReadCount, 0)
    }

    func testSnapshotFinishingAfterSessionInvalidationIsDiscarded() async {
        let target = makeTarget(windowID: 86)
        let factory = FakeWindowCaptureStreamFactory { source, _ in
            source.startFrame = makeFrame(
                for: source.targetKey,
                sequence: 1,
                uptime: 10,
                byte: 7
            )
        }
        var manager: WindowCaptureStreamManager!
        manager = WindowCaptureStreamManager(factory: factory, takeSnapshot: { target, _ in
            manager.invalidate()
            return self.makeSnapshot(target, pixels: "late")
        })
        let shot = await manager.captureSnapshot(for: target, scale: 0.5)
        XCTAssertNil(shot)
        XCTAssertEqual(factory.sources[0].retireCount, 1)
    }

    private func makeSnapshot(_ target: WindowCaptureStreamTarget, pixels: String) -> WindowShot {
        WindowShot(
            base64: pixels, width: target.key.pixelWidth, height: target.key.pixelHeight,
            originX: target.originX, originY: target.originY,
            pointWidth: target.pointWidth, pointHeight: target.pointHeight,
            windowID: target.key.windowID, source: .screenshotManager
        )
    }

    func testEveryDispatchedMutationSettlesBeforeTheNextOnDemandSnapshot() async throws {
        MutationClock.resetForTests()
        defer { MutationClock.resetForTests() }
        let target = makeTarget(windowID: 81)
        let factory = FakeWindowCaptureStreamFactory { source, _ in
            source.startFrame = makeFrame(
                for: source.targetKey,
                sequence: 1,
                uptime: 10,
                byte: 7
            )
        }
        var captures = 0
        var captureTimes: [TimeInterval] = []
        let manager = WindowCaptureStreamManager(factory: factory, takeSnapshot: { target, _ in
            captures += 1
            captureTimes.append(ProcessInfo.processInfo.systemUptime)
            return self.makeSnapshot(target, pixels: "unchanged-pixels")
        })
        var previousMutation: TimeInterval?
        for expectedCaptureCount in 1...2 {
            // Drive the real dispatcher; do not hand-write its timestamp.
            _ = try await ForegroundMutationRunner.run(lease: makeBackgroundLease(target)) { true }
            XCTAssertNotNil(MutationClock.lastMutation())
            XCTAssertNotEqual(MutationClock.lastMutation(), previousMutation)
            previousMutation = MutationClock.lastMutation()
            let pendingMutation = MutationClock.takeMutation()
            let shot = await CommandRouter.captureSettledWindowShot(
                appIsBusy: false,
                lastMutationAt: pendingMutation
            ) {
                await manager.captureSnapshot(for: target, scale: 0.5)
            }
            XCTAssertEqual(shot?.base64, "unchanged-pixels")
            XCTAssertEqual(captures, expectedCaptureCount, "Identical pixels still require a new capture")
            self.assertMutationHasSettledBeforeCapture(
                pendingMutation,
                capturedAt: captureTimes[expectedCaptureCount - 1]
            )
            XCTAssertNil(MutationClock.lastMutation(), "The settle marker is one-shot")
        }
        XCTAssertEqual(factory.sources.count, 1)
        XCTAssertGreaterThan(factory.sources[0].latestReadCount, 0)
    }

    func testPartiallyFailedDispatchAlsoSettlesBeforeTheOnDemandSnapshot() async throws {
        MutationClock.resetForTests()
        defer { MutationClock.resetForTests() }
        let target = makeTarget(windowID: 83)
        let factory = FakeWindowCaptureStreamFactory { source, _ in
            source.startFrame = makeFrame(
                for: source.targetKey,
                sequence: 1,
                uptime: 10,
                byte: 7
            )
        }
        var capturedAt: TimeInterval?
        let manager = WindowCaptureStreamManager(factory: factory, takeSnapshot: { target, _ in
            capturedAt = ProcessInfo.processInfo.systemUptime
            return self.makeSnapshot(target, pixels: "partial-action-state")
        })
        do {
            let _: Bool = try await ForegroundMutationRunner.run(lease: makeBackgroundLease(target)) {
                throw CUError("partial_action", "An event may already have been delivered")
            }
            XCTFail("expected the original action failure")
        } catch let error as CUError {
            XCTAssertEqual(error.code, "partial_action")
        }
        XCTAssertNotNil(MutationClock.lastMutation())
        let pendingMutation = MutationClock.takeMutation()
        let shot = await CommandRouter.captureSettledWindowShot(
            appIsBusy: false,
            lastMutationAt: pendingMutation
        ) {
            await manager.captureSnapshot(for: target, scale: 0.5)
        }
        XCTAssertEqual(shot?.base64, "partial-action-state")
        self.assertMutationHasSettledBeforeCapture(
            pendingMutation,
            capturedAt: try XCTUnwrap(capturedAt)
        )
        XCTAssertGreaterThan(factory.sources[0].latestReadCount, 0)
    }

    private func assertMutationHasSettledBeforeCapture(
        _ mutationAt: TimeInterval?,
        capturedAt: TimeInterval
    ) {
        XCTAssertNotNil(mutationAt)
        XCTAssertEqual(UISettlePolicy.delay(
            now: capturedAt,
            lastMutationAt: mutationAt,
            appIsBusy: false
        ), 0, "The actual screenshot callback must run after the action's settle deadline")
    }

    private func makeBackgroundLease(_ target: WindowCaptureStreamTarget) throws -> ForegroundLease {
        let process = try XCTUnwrap(ProvenProcessTarget(pid: target.key.pid, identity: target.key.processIdentity))
        return try ForegroundLease.acquire(target: process, runtime: ForegroundLeaseRuntime(
            inputSnapshot: { PhysicalInputEpochSnapshot(epoch: 0, available: true) },
            frontmostTarget: { nil },
            currentIdentity: { _ in target.key.processIdentity },
            activate: { _ in XCTFail("must not take foreground"); return false },
            verifyFrontmost: { _ in XCTFail("must not take foreground"); return false }
        ))
    }

    func testSameTargetReusesStreamAndReturnsNewestFrameAcrossCoveredAction() async {
        let factory = FakeWindowCaptureStreamFactory { source, _ in
            source.startFrame = makeFrame(for: source.targetKey, sequence: 1, uptime: 10, byte: 1)
        }
        let manager = makeManager(factory: factory)
        let target = makeTarget(windowID: 10)

        let first = await manager.frame(for: target, newerThanUptime: nil)
        XCTAssertEqual(first?.sequence, 1)
        XCTAssertEqual(factory.sources.count, 1)

        factory.sources[0].publish(
            makeFrame(for: target.key, sequence: 3, uptime: 12, byte: 3)
        )
        let afterCoveredAction = await manager.frame(
            for: target,
            newerThanUptime: 11
        )

        XCTAssertEqual(afterCoveredAction?.sequence, 3)
        XCTAssertEqual(afterCoveredAction?.bytes.first, 3)
        XCTAssertEqual(factory.sources.count, 1)
        XCTAssertEqual(factory.sources[0].startCount, 1)
        XCTAssertEqual(factory.sources[0].retireCount, 0)
    }

    func testIdenticalPixelsWithANewerSequenceSatisfyFreshness() async {
        let factory = FakeWindowCaptureStreamFactory { source, _ in
            source.startFrame = makeFrame(for: source.targetKey, sequence: 1, uptime: 10, byte: 7)
        }
        let manager = makeManager(factory: factory)
        let target = makeTarget(windowID: 11)

        let first = await manager.frame(for: target, newerThanUptime: nil)
        XCTAssertEqual(first?.sequence, 1)

        let source = factory.sources[0]
        source.onLatestRead = { source, readCount in
            guard readCount >= 2 else { return }
            source.publish(
                makeFrame(for: target.key, sequence: 2, uptime: 20, byte: 7)
            )
        }
        let fresh = await manager.frame(for: target, newerThanUptime: 15)

        XCTAssertEqual(fresh?.sequence, 2)
        XCTAssertEqual(fresh?.bytes, first?.bytes)
        XCTAssertEqual(factory.sources.count, 1)
    }

    func testPostMutationTimeoutNeverReturnsThePreMutationFrame() async {
        let factory = FakeWindowCaptureStreamFactory { source, _ in
            source.startFrame = makeFrame(for: source.targetKey, sequence: 1, uptime: 10, byte: 4)
        }
        let manager = makeManager(factory: factory)
        let target = makeTarget(windowID: 12)

        let initial = await manager.frame(for: target, newerThanUptime: nil)
        XCTAssertNotNil(initial)
        let stale = await manager.frame(for: target, newerThanUptime: 11)

        XCTAssertNil(stale)
        XCTAssertEqual(factory.sources.count, 2)
        XCTAssertEqual(factory.sources[0].retireCount, 1)
        XCTAssertEqual(factory.sources[1].retireCount, 0)
        XCTAssertEqual(manager.activeKeyForTesting, target.key)
    }

    func testPostMutationStarvationRebuildsOnceAndReturnsAStartedFrame() async {
        let factory = FakeWindowCaptureStreamFactory { source, index in
            source.startFrame = makeFrame(
                for: source.targetKey,
                sequence: 1,
                uptime: index == 0 ? 10 : 20,
                byte: UInt8(index + 1)
            )
        }
        let manager = makeManager(factory: factory)
        let target = makeTarget(windowID: 13)

        _ = await manager.frame(for: target, newerThanUptime: nil)
        let recovered = await manager.frame(for: target, newerThanUptime: 15)

        XCTAssertEqual(recovered?.receivedUptime, 20)
        XCTAssertEqual(recovered?.bytes.first, 2)
        XCTAssertEqual(factory.sources.count, 2)
        XCTAssertEqual(factory.sources[0].retireCount, 1)
        XCTAssertEqual(factory.sources[1].retireCount, 0)
    }

    func testWindowSwitchRetiresOldStreamAndLateFramesCannotLeak() async {
        let factory = FakeWindowCaptureStreamFactory { source, index in
            source.startFrame = makeFrame(
                for: source.targetKey,
                sequence: 1,
                uptime: 10 + Double(index),
                byte: UInt8(index + 1)
            )
        }
        let manager = makeManager(factory: factory)
        let targetA = makeTarget(windowID: 21)
        let targetB = makeTarget(windowID: 22)

        let frameA = await manager.frame(for: targetA, newerThanUptime: nil)
        let generationA = manager.activeGenerationForTesting
        let frameB = await manager.frame(for: targetB, newerThanUptime: nil)
        let generationB = manager.activeGenerationForTesting

        XCTAssertEqual(frameA?.bytes.first, 1)
        XCTAssertEqual(frameB?.bytes.first, 2)
        XCTAssertNotEqual(generationA, generationB)
        XCTAssertEqual(factory.sources.count, 2)
        XCTAssertEqual(factory.sources[0].retireCount, 1)

        factory.sources[0].publish(
            makeFrame(for: targetA.key, sequence: 99, uptime: 99, byte: 99)
        )
        let stillB = await manager.frame(for: targetB, newerThanUptime: nil)
        XCTAssertEqual(stillB?.bytes.first, 2)
        XCTAssertEqual(manager.activeKeyForTesting, targetB.key)
    }

    func testPIDReuseReplacesStreamEvenWhenPIDAndWindowIDMatch() async {
        let factory = FakeWindowCaptureStreamFactory { source, index in
            source.startFrame = makeFrame(
                for: source.targetKey,
                sequence: 1,
                uptime: 10,
                byte: UInt8(index + 1)
            )
        }
        let manager = makeManager(factory: factory)
        let firstLifetime = makeTarget(windowID: 31, launchTime: 100)
        let reusedPID = makeTarget(windowID: 31, launchTime: 200)

        _ = await manager.frame(for: firstLifetime, newerThanUptime: nil)
        let replacement = await manager.frame(for: reusedPID, newerThanUptime: nil)

        XCTAssertEqual(replacement?.bytes.first, 2)
        XCTAssertEqual(factory.sources.count, 2)
        XCTAssertEqual(factory.sources[0].retireCount, 1)
        XCTAssertEqual(manager.activeKeyForTesting?.processIdentity.launchTime, 200)
    }

    func testResizeCannotReuseAFrameFromTheOldConfiguration() async {
        let factory = FakeWindowCaptureStreamFactory { source, index in
            source.startFrame = makeFrame(
                for: source.targetKey,
                sequence: 1,
                uptime: 10,
                byte: UInt8(index + 1)
            )
        }
        let manager = makeManager(factory: factory)
        let before = makeTarget(windowID: 41, pixelWidth: 2, pixelHeight: 2)
        let after = makeTarget(windowID: 41, pixelWidth: 4, pixelHeight: 3)

        _ = await manager.frame(for: before, newerThanUptime: nil)
        let resized = await manager.frame(for: after, newerThanUptime: nil)

        XCTAssertEqual(resized?.width, 4)
        XCTAssertEqual(resized?.height, 3)
        XCTAssertEqual(resized?.bytes.first, 2)
        XCTAssertEqual(factory.sources.count, 2)
        XCTAssertEqual(factory.sources[0].retireCount, 1)
    }

    func testMovingTheSameWindowRebuildsItsDisplayRegion() async {
        let factory = FakeWindowCaptureStreamFactory { source, _ in
            source.startFrame = makeFrame(
                for: source.targetKey,
                sequence: 1,
                uptime: 10,
                byte: 5
            )
        }
        let manager = makeManager(factory: factory)
        let before = makeTarget(windowID: 42, originX: 100, originY: 200)
        let after = makeTarget(windowID: 42, originX: 500, originY: 600)

        _ = await manager.frame(for: before, newerThanUptime: nil)
        let moved = await manager.frame(for: after, newerThanUptime: nil)

        XCTAssertEqual(moved?.bytes.first, 5)
        XCTAssertEqual(factory.sources.count, 2, "The old display crop no longer follows a moved window")
        XCTAssertEqual(factory.sources[0].startCount, 1)
        XCTAssertEqual(factory.sources[0].retireCount, 1)
        XCTAssertEqual(manager.activeKeyForTesting, after.key)
    }

    func testPointSizeChangeRebuildsTheRegionEvenWhenPixelDimensionsMatch() async {
        let factory = FakeWindowCaptureStreamFactory { source, index in
            source.startFrame = makeFrame(
                for: source.targetKey, sequence: 1, uptime: 10, byte: UInt8(index + 1)
            )
        }
        let manager = makeManager(factory: factory)
        let before = makeTarget(windowID: 43)
        let after = WindowCaptureStreamTarget(
            key: before.key, originX: before.originX, originY: before.originY,
            pointWidth: before.pointWidth / 2, pointHeight: before.pointHeight / 2
        )
        _ = await manager.frame(for: before, newerThanUptime: nil)
        let changed = await manager.frame(for: after, newerThanUptime: nil)
        XCTAssertEqual(changed?.bytes.first, 2)
        XCTAssertEqual(factory.sources.count, 2)
        XCTAssertEqual(factory.sources[0].retireCount, 1)
    }

    func testDelegateFailureRestartsOnceAndDropsTheFailedFrame() async {
        let factory = FakeWindowCaptureStreamFactory { source, index in
            source.startFrame = makeFrame(
                for: source.targetKey,
                sequence: 1,
                uptime: 10,
                byte: UInt8(index + 1)
            )
        }
        let manager = makeManager(factory: factory)
        let target = makeTarget(windowID: 51)

        let first = await manager.frame(for: target, newerThanUptime: nil)
        XCTAssertEqual(first?.bytes.first, 1)
        factory.sources[0].failed = true

        let recovered = await manager.frame(for: target, newerThanUptime: nil)

        XCTAssertEqual(recovered?.bytes.first, 2)
        XCTAssertEqual(factory.sources.count, 2)
        XCTAssertEqual(factory.sources[0].retireCount, 1)
        XCTAssertEqual(factory.sources[1].startCount, 1)
    }

    func testOneBoundedRetryRecoversAStartFailure() async {
        let factory = FakeWindowCaptureStreamFactory { source, index in
            if index == 0 {
                source.startError = CUError("capture_failed", "fixture start failure")
            } else {
                source.startFrame = makeFrame(
                    for: source.targetKey,
                    sequence: 1,
                    uptime: 10,
                    byte: 8
                )
            }
        }
        let manager = makeManager(factory: factory)
        let target = makeTarget(windowID: 52)

        let recovered = await manager.frame(for: target, newerThanUptime: nil)

        XCTAssertEqual(recovered?.bytes.first, 8)
        XCTAssertEqual(factory.sources.count, 2)
        XCTAssertEqual(factory.sources[0].retireCount, 1)
        XCTAssertEqual(factory.sources[1].startCount, 1)
    }

    func testSessionInvalidationStopsTheStreamAndMakesLateFramesInert() async {
        let factory = FakeWindowCaptureStreamFactory { source, index in
            source.startFrame = makeFrame(
                for: source.targetKey,
                sequence: 1,
                uptime: 10,
                byte: UInt8(index + 1)
            )
        }
        let manager = makeManager(factory: factory)
        let target = makeTarget(windowID: 61)

        _ = await manager.frame(for: target, newerThanUptime: nil)
        let oldSource = factory.sources[0]
        manager.invalidate()
        oldSource.publish(
            makeFrame(for: target.key, sequence: 100, uptime: 100, byte: 100)
        )

        XCTAssertNil(manager.activeKeyForTesting)
        XCTAssertEqual(oldSource.retireCount, 1)

        let nextTurn = await manager.frame(for: target, newerThanUptime: nil)
        XCTAssertEqual(nextTurn?.bytes.first, 2)
        XCTAssertEqual(factory.sources.count, 2)
    }

    func testOnlyPixelBearingFrameStatusesAreAccepted() {
        XCTAssertTrue(WindowCaptureFrameStatusPolicy.accepts(.started))
        XCTAssertTrue(WindowCaptureFrameStatusPolicy.accepts(.complete))
        XCTAssertFalse(WindowCaptureFrameStatusPolicy.accepts(.idle))
        XCTAssertFalse(WindowCaptureFrameStatusPolicy.accepts(.blank))
        XCTAssertFalse(WindowCaptureFrameStatusPolicy.accepts(.suspended))
        XCTAssertFalse(WindowCaptureFrameStatusPolicy.accepts(.stopped))
        XCTAssertFalse(WindowCaptureFrameStatusPolicy.marksFailure(.started))
        XCTAssertFalse(WindowCaptureFrameStatusPolicy.marksFailure(.complete))
        XCTAssertFalse(WindowCaptureFrameStatusPolicy.marksFailure(.idle))
        XCTAssertFalse(WindowCaptureFrameStatusPolicy.marksFailure(.blank))
        XCTAssertFalse(WindowCaptureFrameStatusPolicy.marksFailure(.suspended))
        XCTAssertTrue(WindowCaptureFrameStatusPolicy.marksFailure(.stopped))
    }

    func testStreamConfigurationUsesCodexCadenceBufferingAndPixelFormat() {
        let target = makeTarget(windowID: 71, pixelWidth: 640, pixelHeight: 480)
        let configuration = ScreenCaptureKitWindowStreamSource.makeConfiguration(
            for: target
        )

        XCTAssertEqual(configuration.width, 640)
        XCTAssertEqual(configuration.height, 480)
        XCTAssertEqual(
            configuration.minimumFrameInterval,
            CMTime(value: 1, timescale: 60)
        )
        XCTAssertEqual(configuration.queueDepth, 5)
        XCTAssertFalse(configuration.showsCursor)
        XCTAssertFalse(configuration.capturesAudio)
        XCTAssertTrue(configuration.scalesToFit)
        XCTAssertTrue(configuration.preservesAspectRatio)
        XCTAssertEqual(configuration.pixelFormat, kCVPixelFormatType_32BGRA)
        XCTAssertEqual(configuration.colorSpaceName, CGColorSpace.sRGB)
        XCTAssertTrue(configuration.ignoreShadowsSingleWindow)
        XCTAssertTrue(configuration.ignoreShadowsDisplay)
    }

    func testDisplaySubscriptionUsesLargestIntersectionInDisplayLocalCoordinates() throws {
        let target = makeTarget(windowID: 73, pixelWidth: 800, pixelHeight: 600)
        let region = try XCTUnwrap(ScreenCaptureKitWindowStreamSource.displayCaptureRegion(
            windowFrame: CGRect(x: -600, y: 100, width: 800, height: 600),
            displayFrames: [
                CGRect(x: 0, y: 0, width: 1728, height: 1117),
                CGRect(x: -1920, y: -200, width: 1920, height: 1080),
            ]
        ))
        XCTAssertEqual(region.displayIndex, 1)
        XCTAssertEqual(region.sourceRect, CGRect(x: 1320, y: 300, width: 600, height: 600))
        let configuration = ScreenCaptureKitWindowStreamSource.makeConfiguration(
            for: target, sourceRect: region.sourceRect
        )
        XCTAssertEqual(configuration.sourceRect, region.sourceRect)
        XCTAssertFalse(configuration.shouldBeOpaque)
        // The crop is only the renderer subscription. Its output still meets
        // the manager's frame contract; on-demand screenshots retain full size.
        XCTAssertEqual(configuration.width, 800)
        XCTAssertEqual(configuration.height, 600)
    }

    func testDisplaySubscriptionRejectsAbsentAndNonIntersectingDisplays() {
        let frame = CGRect(x: 100, y: 200, width: 800, height: 600)
        XCTAssertNil(ScreenCaptureKitWindowStreamSource.displayCaptureRegion(
            windowFrame: frame, displayFrames: []
        ))
        XCTAssertNil(ScreenCaptureKitWindowStreamSource.displayCaptureRegion(
            windowFrame: frame, displayFrames: [CGRect(x: -1920, y: 0, width: 1920, height: 1080)]
        ))
        XCTAssertNil(ScreenCaptureKitWindowStreamSource.displayCaptureRegion(
            windowFrame: frame, displayFrames: [.infinite, .null]
        ))
    }

    func testCopiedBGRAFramePreservesLosslessEvidenceAndPresentsJPEGAtTheSameGeometry() throws {
        let target = makeTarget(
            windowID: 72,
            pixelWidth: 1,
            pixelHeight: 1,
            originX: 300,
            originY: 400
        )
        let frame = WindowCaptureStreamFrame(
            bytes: Data([0x00, 0x00, 0xff, 0xff]),
            width: 1,
            height: 1,
            bytesPerRow: 4,
            sequence: 1,
            receivedUptime: 10
        )

        let shot = try XCTUnwrap(Capture.windowShot(from: frame, target: target))
        let evidence = try XCTUnwrap(Data(base64Encoded: shot.base64))
        XCTAssertEqual(Array(evidence.prefix(8)), [137, 80, 78, 71, 13, 10, 26, 10])
        XCTAssertEqual(shot.mimeType, "image/png")
        let model = Capture.modelWindowImage(shot)
        let jpeg = try XCTUnwrap(Data(base64Encoded: model.base64))
        XCTAssertEqual(Array(jpeg.prefix(2)), [255, 216])
        XCTAssertEqual(model.mimeType, "image/jpeg")
        XCTAssertEqual(shot.base64, evidence.base64EncodedString())
        XCTAssertEqual(shot.width, 1)
        XCTAssertEqual(shot.height, 1)
        XCTAssertEqual(shot.originX, 300)
        XCTAssertEqual(shot.originY, 400)
        XCTAssertEqual(shot.windowID, 72)
        XCTAssertEqual(shot.source, .stream)
    }

    private func makeManager(
        factory: FakeWindowCaptureStreamFactory
    ) -> WindowCaptureStreamManager {
        WindowCaptureStreamManager(
            factory: factory,
            frameWaitAttempts: 0,
            frameWaitNanoseconds: 0
        )
    }

    private func makeTarget(
        windowID: CGWindowID,
        launchTime: TimeInterval = 100,
        pixelWidth: Int = 2,
        pixelHeight: Int = 2,
        originX: Double = 100,
        originY: Double = 200
    ) -> WindowCaptureStreamTarget {
        WindowCaptureStreamTarget(
            key: WindowCaptureStreamKey(
                pid: 4242,
                processIdentity: AXTreeProcessIdentity(
                    bundleID: "com.example.fixture",
                    executablePath: "/Applications/Fixture.app/Contents/MacOS/Fixture",
                    launchTime: launchTime
                ),
                windowID: windowID,
                pixelWidth: pixelWidth,
                pixelHeight: pixelHeight
            ),
            originX: originX,
            originY: originY,
            pointWidth: Double(pixelWidth),
            pointHeight: Double(pixelHeight)
        )
    }
}

@MainActor
private final class FakeWindowCaptureStreamFactory: WindowCaptureStreamSourceFactory {
    typealias Configure = (FakeWindowCaptureStreamSource, Int) -> Void

    private let configure: Configure
    private(set) var sources: [FakeWindowCaptureStreamSource] = []

    init(configure: @escaping Configure) {
        self.configure = configure
    }

    func makeSource(
        for target: WindowCaptureStreamTarget
    ) -> any WindowCaptureStreamSource {
        let source = FakeWindowCaptureStreamSource(targetKey: target.key)
        configure(source, sources.count)
        sources.append(source)
        return source
    }
}

@MainActor
private final class FakeWindowCaptureStreamSource: WindowCaptureStreamSource {
    let targetKey: WindowCaptureStreamKey
    var failed = false
    var startError: CUError?
    var startFrame: WindowCaptureStreamFrame?
    var onLatestRead: ((FakeWindowCaptureStreamSource, Int) -> Void)?
    private(set) var startCount = 0
    private(set) var retireCount = 0
    private(set) var latestReadCount = 0
    private var latest: WindowCaptureStreamFrame?
    private var sampleCount: UInt64 = 0
    private var latestSampleStatus: Int?
    private var latestSampleReceivedUptime: TimeInterval?

    init(targetKey: WindowCaptureStreamKey) {
        self.targetKey = targetKey
    }

    var hasFailed: Bool { failed }

    func sampleDiagnostic() -> WindowCaptureStreamSourceDiagnostic {
        WindowCaptureStreamSourceDiagnostic(
            hasFailed: failed,
            latestFrameSequence: latest?.sequence,
            latestFrameReceivedUptime: latest?.receivedUptime,
            sampleCount: sampleCount,
            latestSampleStatus: latestSampleStatus,
            latestSampleReceivedUptime: latestSampleReceivedUptime
        )
    }

    func start() async throws {
        startCount += 1
        if let startError { throw startError }
        if let startFrame { publish(startFrame) }
    }

    func latestFrame() -> WindowCaptureStreamFrame? {
        latestReadCount += 1
        onLatestRead?(self, latestReadCount)
        return latest
    }

    func retire() {
        retireCount += 1
    }

    func publish(_ frame: WindowCaptureStreamFrame) {
        latest = frame
        publishStatus(.complete, uptime: frame.receivedUptime)
    }

    func publishStatus(_ status: SCFrameStatus, uptime: TimeInterval) {
        sampleCount += 1
        latestSampleStatus = status.rawValue
        latestSampleReceivedUptime = uptime
    }
}

private func makeFrame(
    for key: WindowCaptureStreamKey,
    sequence: UInt64,
    uptime: TimeInterval,
    byte: UInt8
) -> WindowCaptureStreamFrame {
    let bytesPerRow = key.pixelWidth * 4
    return WindowCaptureStreamFrame(
        bytes: Data(
            repeating: byte,
            count: bytesPerRow * key.pixelHeight
        ),
        width: key.pixelWidth,
        height: key.pixelHeight,
        bytesPerRow: bytesPerRow,
        sequence: sequence,
        receivedUptime: uptime
    )
}
