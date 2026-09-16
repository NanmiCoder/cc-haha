import AppKit
import CoreGraphics
import XCTest

@testable import cc_haha_computer_use

final class ClipboardPasteReceiptTests: XCTestCase {
    @MainActor
    func testReadWithoutTargetSignalsUsesOnlyTheShortFallbackWindow() async throws {
        let fixture = PasteReceiptFixture()
        defer { fixture.close() }
        try await ClipboardPasteReceipt.perform(
            text: "temporary", lease: ClipboardLease(pasteboard: fixture.board)
        ) { validate in
            try await fixture.sendPaste(validate)
            XCTAssertEqual(fixture.board.string(forType: .string), "temporary")
        }
        let diagnostic = try XCTUnwrap(ClipboardPasteReceipt.lastDiagnostic)
        let readElapsed = try XCTUnwrap(diagnostic.readElapsedMilliseconds)
        XCTAssertGreaterThanOrEqual(diagnostic.elapsedMilliseconds - readElapsed, 90)
        XCTAssertLessThan(diagnostic.elapsedMilliseconds - readElapsed, 600,
                          "a successful read without AX signals has a 100 ms fallback, not a fixed two-second hold")
        XCTAssertEqual(fixture.board.string(forType: .string), "original")
    }

    @MainActor
    func testHtmlPastePromisesRichAndPlainRepresentationsThenRestoresClipboard() async throws {
        let fixture = PasteReceiptFixture()
        defer { fixture.close() }
        let lease = ClipboardLease(pasteboard: fixture.board)

        try await ClipboardPasteReceipt.perform(
            text: "<strong>Hello</strong> world",
            format: .html,
            lease: lease
        ) { validate in
            try await fixture.sendPaste(validate)
            XCTAssertEqual(
                String(data: fixture.board.data(forType: .html) ?? Data(), encoding: .utf8),
                "<strong>Hello</strong> world"
            )
            XCTAssertTrue((fixture.board.string(forType: .string) ?? "").contains("Hello world"))
        }

        XCTAssertEqual(ClipboardPasteReceipt.lastDiagnostic?.status, "completed")
        XCTAssertEqual(fixture.board.string(forType: .string), "original")
    }

    @MainActor
    func testPasteWaitsForARealReadBeyondTheOld180MillisecondWindow() async throws {
        let fixture = PasteReceiptFixture()
        defer { fixture.close() }
        let lease = ClipboardLease(pasteboard: fixture.board)
        var returned = false
        var reader: Task<Void, Never>?
        try await ClipboardPasteReceipt.perform(text: "temporary", lease: lease) { validate in
            try await fixture.sendPaste(validate)
            reader = Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(240))
                XCTAssertFalse(returned, "paste cannot complete before its promised data is read")
                XCTAssertTrue(lease.temporaryWriteIsCurrent())
                XCTAssertEqual(fixture.board.string(forType: .string), "temporary")
            }
        }
        returned = true
        await reader?.value

        let diagnostic = try XCTUnwrap(ClipboardPasteReceipt.lastDiagnostic)
        XCTAssertEqual(diagnostic.status, "completed")
        XCTAssertTrue(diagnostic.dataRequested)
        XCTAssertTrue(diagnostic.dataSupplied)
        let readElapsed = try XCTUnwrap(diagnostic.readElapsedMilliseconds)
        XCTAssertGreaterThan(readElapsed, 180)
        XCTAssertGreaterThanOrEqual(diagnostic.elapsedMilliseconds - readElapsed, 90)
        XCTAssertTrue(diagnostic.ownedBeforeRestore)
        XCTAssertTrue(diagnostic.restored)
        XCTAssertEqual(fixture.board.string(forType: .string), "original")
        XCTAssertEqual(fixture.events.map(\.type), [.flagsChanged, .keyDown, .flagsChanged, .keyUp])
    }

    @MainActor
    func testAnEarlyReaderCannotRestoreClipboardBeforeTheTargetReads() async throws {
        let fixture = PasteReceiptFixture()
        defer { fixture.close() }
        let lease = ClipboardLease(pasteboard: fixture.board)
        var returned = false
        var targetChanged = false
        var targetReader: Task<Void, Never>?

        try await ClipboardPasteReceipt.perform(
            text: "temporary", lease: lease, timeout: .milliseconds(450),
            targetObservation: ClipboardPasteObservation(hasSignals: true, hasChanged: { targetChanged })
        ) { validate in
            try await fixture.sendPaste(validate)
            // A clipboard observer can request the promised bytes first.
            XCTAssertEqual(fixture.board.string(forType: .string), "temporary")
            targetReader = Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(300))
                XCTAssertFalse(returned, "an unidentified reader cannot end the target's consumption window")
                XCTAssertTrue(lease.temporaryWriteIsCurrent())
                XCTAssertEqual(fixture.board.string(forType: .string), "temporary")
                targetChanged = true
            }
        }
        returned = true
        await targetReader?.value

        let diagnostic = try XCTUnwrap(ClipboardPasteReceipt.lastDiagnostic)
        XCTAssertEqual(diagnostic.status, "completed")
        XCTAssertTrue(diagnostic.dataSupplied)
        XCTAssertTrue(diagnostic.restored)
        XCTAssertEqual(fixture.events.count, 4)
        XCTAssertEqual(fixture.board.string(forType: .string), "original")
    }

    @MainActor
    func testCancellationAfterAnEarlyReadPreservesTheTargetsConsumptionWindow() async throws {
        let fixture = PasteReceiptFixture()
        defer { fixture.close() }
        let lease = ClipboardLease(pasteboard: fixture.board)
        var targetReader: Task<Void, Never>?
        var targetChanged = false
        let task = Task { @MainActor in
            try await ClipboardPasteReceipt.perform(
                text: "temporary", lease: lease, timeout: .milliseconds(450),
                targetObservation: ClipboardPasteObservation(hasSignals: true, hasChanged: { targetChanged })
            ) { validate in
                try await fixture.sendPaste(validate)
                XCTAssertEqual(fixture.board.string(forType: .string), "temporary")
                targetReader = Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(300))
                    XCTAssertTrue(lease.temporaryWriteIsCurrent())
                    XCTAssertEqual(fixture.board.string(forType: .string), "temporary")
                    targetChanged = true
                }
                withUnsafeCurrentTask { $0?.cancel() }
            }
        }
        do {
            try await task.value
            XCTFail("cancellation must still reach the caller after the bounded window")
        } catch is CancellationError {}
        await targetReader?.value

        XCTAssertEqual(ClipboardPasteReceipt.lastDiagnostic?.status, "cancelled")
        XCTAssertEqual(ClipboardPasteReceipt.lastDiagnostic?.dataSupplied, true)
        XCTAssertEqual(ClipboardPasteReceipt.lastDiagnostic?.restored, true)
        XCTAssertEqual(fixture.events.count, 4)
        XCTAssertEqual(fixture.board.string(forType: .string), "original")
    }

    @MainActor
    func testExternalCopyAfterAnEarlyReadStillWinsDuringTheConsumptionWindow() async throws {
        let fixture = PasteReceiptFixture()
        defer { fixture.close() }
        var externalCopy: Task<Void, Never>?
        do {
            try await ClipboardPasteReceipt.perform(
                text: "temporary", lease: ClipboardLease(pasteboard: fixture.board),
                timeout: .milliseconds(450),
                targetObservation: ClipboardPasteObservation(hasSignals: true)
            ) { validate in
                try await fixture.sendPaste(validate)
                XCTAssertEqual(fixture.board.string(forType: .string), "temporary")
                externalCopy = Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(300))
                    fixture.board.clearContents()
                    XCTAssertTrue(fixture.board.setString("new external copy", forType: .string))
                }
            }
            XCTFail("an early read must not hide a later ownership change")
        } catch let error as CUError {
            XCTAssertEqual(error.code, "clipboard_changed")
        }
        await externalCopy?.value

        XCTAssertEqual(ClipboardPasteReceipt.lastDiagnostic?.status, "clipboard_changed")
        XCTAssertEqual(ClipboardPasteReceipt.lastDiagnostic?.dataSupplied, true)
        XCTAssertEqual(ClipboardPasteReceipt.lastDiagnostic?.restored, false)
        XCTAssertEqual(fixture.events.count, 4)
        XCTAssertEqual(fixture.board.string(forType: .string), "new external copy")
    }

    @MainActor
    func testNoReadThrowsInsteadOfReportingSuccessfulPaste() async throws {
        let fixture = PasteReceiptFixture()
        defer { fixture.close() }
        do {
            try await ClipboardPasteReceipt.perform(
                text: "temporary", lease: ClipboardLease(pasteboard: fixture.board),
                timeout: .milliseconds(30), sendPaste: fixture.sendPaste
            )
            XCTFail("posting Command-V is not confirmation that its data was read")
        } catch let error as CUError {
            XCTAssertEqual(error.code, "clipboard_read_timeout")
        }
        let diagnostic = try XCTUnwrap(ClipboardPasteReceipt.lastDiagnostic)
        XCTAssertEqual(diagnostic.status, "clipboard_read_timeout")
        XCTAssertFalse(diagnostic.dataSupplied)
        XCTAssertNil(diagnostic.readElapsedMilliseconds)
        XCTAssertTrue(diagnostic.restored)
        XCTAssertEqual(fixture.events.count, 4)
        XCTAssertEqual(fixture.board.string(forType: .string), "original")
    }

    @MainActor
    func testExternalCopyWhileWaitingWinsAndIsNotSuccessfulConsumption() async throws {
        let fixture = PasteReceiptFixture()
        defer { fixture.close() }
        do {
            try await ClipboardPasteReceipt.perform(
                text: "temporary", lease: ClipboardLease(pasteboard: fixture.board),
                timeout: .milliseconds(30)
            ) { validate in
                try await fixture.sendPaste(validate)
                fixture.board.clearContents()
                XCTAssertTrue(fixture.board.setString("new external copy", forType: .string))
            }
            XCTFail("a replacement pasteboard is not a read receipt")
        } catch let error as CUError {
            XCTAssertEqual(error.code, "clipboard_changed")
        }
        let diagnostic = try XCTUnwrap(ClipboardPasteReceipt.lastDiagnostic)
        XCTAssertEqual(diagnostic.status, "clipboard_changed")
        XCTAssertFalse(diagnostic.dataSupplied)
        XCTAssertFalse(diagnostic.ownedBeforeRestore)
        XCTAssertFalse(diagnostic.restored)
        XCTAssertEqual(fixture.board.string(forType: .string), "new external copy")
    }

    @MainActor
    func testIdenticalTextOnANewPasteRequiresANewReadReceipt() async throws {
        let fixture = PasteReceiptFixture()
        defer { fixture.close() }
        try await ClipboardPasteReceipt.perform(
            text: "same temporary text", lease: ClipboardLease(pasteboard: fixture.board)
        ) { validate in
            try await fixture.sendPaste(validate)
            XCTAssertEqual(fixture.board.string(forType: .string), "same temporary text")
        }
        XCTAssertEqual(ClipboardPasteReceipt.lastDiagnostic?.dataSupplied, true)

        do {
            try await ClipboardPasteReceipt.perform(
                text: "same temporary text", lease: ClipboardLease(pasteboard: fixture.board),
                timeout: .milliseconds(30), sendPaste: fixture.sendPaste
            )
            XCTFail("the previous operation's receipt must not satisfy a new paste")
        } catch let error as CUError {
            XCTAssertEqual(error.code, "clipboard_read_timeout")
        }
        XCTAssertEqual(ClipboardPasteReceipt.lastDiagnostic?.dataSupplied, false)
        XCTAssertEqual(fixture.events.count, 8)
        XCTAssertEqual(fixture.board.string(forType: .string), "original")
    }

    @MainActor
    func testCancellationAfterPostingStillLetsThePendingReadFinishBeforeRestore() async throws {
        let fixture = PasteReceiptFixture()
        defer { fixture.close() }
        let lease = ClipboardLease(pasteboard: fixture.board)
        var reader: Task<Void, Never>?
        let task = Task { @MainActor in
            try await ClipboardPasteReceipt.perform(text: "temporary", lease: lease) { validate in
                try await fixture.sendPaste(validate)
                reader = Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(240))
                    XCTAssertTrue(lease.temporaryWriteIsCurrent())
                    XCTAssertEqual(fixture.board.string(forType: .string), "temporary")
                }
                withUnsafeCurrentTask { $0?.cancel() }
            }
        }
        do {
            try await task.value
            XCTFail("cancellation must still reach the caller")
        } catch is CancellationError {}
        await reader?.value
        XCTAssertEqual(ClipboardPasteReceipt.lastDiagnostic?.status, "cancelled")
        XCTAssertEqual(ClipboardPasteReceipt.lastDiagnostic?.dataSupplied, true)
        XCTAssertEqual(ClipboardPasteReceipt.lastDiagnostic?.restored, true)
        XCTAssertEqual(fixture.events.count, 4, "waiting or cancellation must not resend Command-V")
        XCTAssertEqual(fixture.board.string(forType: .string), "original")
    }

    @MainActor
    func testAlreadyCancelledPasteNeverWritesOrPosts() async throws {
        let fixture = PasteReceiptFixture()
        defer { fixture.close() }
        let originalCount = fixture.board.changeCount
        let task = Task { @MainActor in
            withUnsafeCurrentTask { $0?.cancel() }
            try await ClipboardPasteReceipt.perform(
                text: "temporary", lease: ClipboardLease(pasteboard: fixture.board),
                sendPaste: fixture.sendPaste
            )
        }
        do {
            try await task.value
            XCTFail("already cancelled")
        } catch is CancellationError {}
        XCTAssertTrue(fixture.events.isEmpty)
        XCTAssertEqual(fixture.board.changeCount, originalCount)
        XCTAssertEqual(fixture.board.string(forType: .string), "original")
        XCTAssertEqual(ClipboardPasteReceipt.lastDiagnostic?.status, "cancelled")
    }

    @MainActor
    func testFinishedCallbackAloneNeverCountsAsRead() async throws {
        let fixture = PasteReceiptFixture()
        defer { fixture.close() }
        let lease = ClipboardLease(pasteboard: fixture.board)
        defer { lease.restoreIfUnchanged() }
        let receipt = try lease.writeTemporaryStringWithReceipt("temporary")
        receipt.pasteboardFinishedWithDataProvider(fixture.board)
        do {
            try await receipt.waitForRead(timeout: .milliseconds(20), ownsClipboard: lease.temporaryWriteIsCurrent)
            XCTFail("finished can mean ownership was relinquished, not consumption")
        } catch let error as CUError {
            XCTAssertEqual(error.code, "clipboard_read_timeout")
        }
    }

    @MainActor
    func testObservedTargetChangeCompletesBeforeTheTwoSecondDeadline() async throws {
        let fixture = PasteReceiptFixture()
        defer { fixture.close() }
        let notifications = ClipboardPasteNotifications()
        var closed = false
        try await ClipboardPasteReceipt.perform(
            text: "temporary", lease: ClipboardLease(pasteboard: fixture.board),
            targetObservation: ClipboardPasteObservation(
                hasSignals: true,
                arm: { notifications.arm($0) },
                hasChanged: { notifications.hasChanged },
                close: {
                    notifications.close()
                    closed = true
                }
            )
        ) { validate in
            try await fixture.sendPaste(validate)
            XCTAssertEqual(fixture.board.string(forType: .string), "temporary")
            notifications.recordTargetChange()
        }
        let diagnostic = try XCTUnwrap(ClipboardPasteReceipt.lastDiagnostic)
        XCTAssertEqual(diagnostic.status, "completed")
        XCTAssertLessThan(diagnostic.elapsedMilliseconds, 600)
        XCTAssertTrue(closed)
        XCTAssertEqual(fixture.events.count, 4)
    }

    @MainActor
    func testReadWithoutAChangeInObservableTargetTimesOutAndRestores() async throws {
        let fixture = PasteReceiptFixture()
        defer { fixture.close() }
        var closed = false
        do {
            try await ClipboardPasteReceipt.perform(
                text: "temporary", lease: ClipboardLease(pasteboard: fixture.board),
                timeout: .milliseconds(60),
                targetObservation: ClipboardPasteObservation(hasSignals: true, close: { closed = true })
            ) { validate in
                try await fixture.sendPaste(validate)
                XCTAssertEqual(fixture.board.string(forType: .string), "temporary")
            }
            XCTFail("a read alone cannot acknowledge an observable field that did not change")
        } catch let error as CUError {
            XCTAssertEqual(error.code, "clipboard_target_timeout")
        }
        let diagnostic = try XCTUnwrap(ClipboardPasteReceipt.lastDiagnostic)
        XCTAssertEqual(diagnostic.status, "clipboard_target_timeout")
        XCTAssertTrue(diagnostic.dataSupplied)
        XCTAssertGreaterThanOrEqual(diagnostic.elapsedMilliseconds - (diagnostic.readElapsedMilliseconds ?? 0), 55)
        XCTAssertTrue(closed)
        XCTAssertEqual(fixture.board.string(forType: .string), "original")
        XCTAssertEqual(fixture.events.count, 4, "timeout must not resend the paste")
    }

    @MainActor
    func testOnlyAnArmedNotificationAfterDataReadConfirmsTheTarget() throws {
        let fixture = PasteReceiptFixture()
        defer { fixture.close() }
        let lease = ClipboardLease(pasteboard: fixture.board)
        defer { lease.restoreIfUnchanged() }
        let receipt = try lease.writeTemporaryStringWithReceipt("temporary")
        let notifications = ClipboardPasteNotifications()
        notifications.recordTargetChange()
        XCTAssertFalse(notifications.hasChanged, "an unarmed callback cannot confirm this paste")
        notifications.arm(receipt)
        notifications.recordTargetChange()
        XCTAssertFalse(notifications.hasChanged, "a callback before the data read cannot confirm consumption")
        XCTAssertEqual(fixture.board.string(forType: .string), "temporary")
        XCTAssertFalse(notifications.hasChanged, "an unrelated clipboard reader cannot confirm the target")
        notifications.recordTargetChange()
        XCTAssertTrue(notifications.hasChanged)
    }

    @MainActor
    func testFailedOrUnchangedAXReadsCannotConfirmTargetConsumption() throws {
        var initialRange = CFRange(location: 2, length: 3)
        var sameRange = initialRange
        var changedRange = CFRange(location: 5, length: 0)
        let initial = try XCTUnwrap(AXValueCreate(.cfRange, &initialRange))
        let same = try XCTUnwrap(AXValueCreate(.cfRange, &sameRange))
        let changed = try XCTUnwrap(AXValueCreate(.cfRange, &changedRange))
        let baseline: [String: CFTypeRef] = ["range": initial, "count": NSNumber(value: 12)]
        XCTAssertFalse(ClipboardPasteObservation.attributesChanged(baseline: baseline, current: [:]))
        XCTAssertFalse(ClipboardPasteObservation.attributesChanged(baseline: baseline, current: ["range": changed]),
                       "a partial AX read must not claim target success")
        XCTAssertFalse(ClipboardPasteObservation.attributesChanged(
            baseline: baseline, current: ["range": same, "count": NSNumber(value: 12)]
        ), "AX value equality must compare values rather than object identity")
        XCTAssertTrue(ClipboardPasteObservation.attributesChanged(
            baseline: baseline, current: ["range": changed, "count": NSNumber(value: 12)]
        ))
        XCTAssertTrue(ClipboardPasteObservation.attributesChanged(
            baseline: baseline, current: ["range": same, "count": NSNumber(value: 15)]
        ))
    }
}

/// The real promised-data provider, paste orchestration and keyboard factory
/// run together. Only focus preparation and actual PID event delivery are fake.
@MainActor
private final class PasteReceiptFixture {
    let board = NSPasteboard.withUniqueName()
    var events: [CGEvent] = []

    init() {
        board.clearContents()
        XCTAssertTrue(board.setString("original", forType: .string))
    }

    func sendPaste(_ validate: @MainActor () throws -> Void) async throws {
        try await KeyboardEventBurst.dispatch(
            chords: KeyMapping.parse("cmd+v"), prepare: { await Task.yield() },
            readFlagsState: { _ in [] }, validateBeforePosting: validate,
            post: { events.append($0) }
        )
    }

    func close() { board.releaseGlobally() }
}
