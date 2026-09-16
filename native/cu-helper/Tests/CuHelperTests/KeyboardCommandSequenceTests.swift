import XCTest

@testable import cc_haha_computer_use

final class KeyboardCommandSequenceTests: XCTestCase {
    @MainActor
    func testMacroWaitsForEachCompleteSingleChordBoundaryInOrder() async throws {
        let chords = try KeyboardCommandSequence.prepare("a b c d", systemKeyCombos: false)
        var history: [String] = []
        var active = false
        try await KeyboardCommandSequence.run(chords: chords) { batch in
            XCTAssertEqual(batch.count, 1, "a macro must not become one rapid native burst")
            XCTAssertFalse(active)
            active = true
            let name = batch.map(\.semanticKey).joined(separator: ",")
            history.append("begin:\(name)")
            await Task.yield()
            history.append("end:\(name)")
            active = false
        }
        XCTAssertEqual(history, ["begin:a", "end:a", "begin:b", "end:b", "begin:c", "end:c", "begin:d", "end:d"])
    }

    @MainActor
    func testUnknownOrForbiddenSuffixRejectsBeforeAnyInput() async {
        for (key, expectedCode) in [("a DefinitelyNotARealKey", "unknown_key"), ("a cmd+q", "grant_flag_required")] {
            var calls = 0
            do {
                let chords = try KeyboardCommandSequence.prepare(key, systemKeyCombos: false)
                try await KeyboardCommandSequence.run(chords: chords) { _ in calls += 1 }
                XCTFail("the complete macro must be preflighted")
            } catch let error as CUError {
                XCTAssertEqual(error.code, expectedCode)
            } catch { XCTFail("unexpected error: \(error)") }
            XCTAssertEqual(calls, 0)
        }
    }

    func testChordLimitAppliesBeforeExecutionAndPreservesSpacedShortcutSyntax() throws {
        XCTAssertEqual(try KeyboardCommandSequence.prepare(String(repeating: "Return ", count: 128), systemKeyCombos: false).count, 128)
        XCTAssertThrowsError(try KeyboardCommandSequence.prepare(String(repeating: "Return ", count: 129), systemKeyCombos: false)) { error in
            XCTAssertEqual((error as? CUError)?.code, "bad_payload")
        }
        let chords = try KeyboardCommandSequence.prepare("cmd + a\n shift + Return", systemKeyCombos: false)
        XCTAssertEqual(chords.count, 2)
        XCTAssertEqual(chords.map(\.flags), [.maskCommand, .maskShift])
    }

    @MainActor
    func testFocusFailureStopsRemainingChordsAndReportsCompletedPrefix() async throws {
        let chords = try KeyboardCommandSequence.prepare("a b c d", systemKeyCombos: false)
        var attempted: [String] = []
        do {
            try await KeyboardCommandSequence.run(chords: chords) { batch in
                attempted.append(contentsOf: batch.map(\.semanticKey))
                if attempted.count == 2 { throw CUError("focus_changed", "test focus changed") }
            }
            XCTFail("must stop after focus loss")
        } catch let error as CUError {
            XCTAssertEqual(error.code, "focus_changed")
            XCTAssertTrue(error.message.contains("1 of 4"))
            XCTAssertTrue(error.message.contains("may already have been delivered"))
            XCTAssertTrue(error.message.contains("do not replay"))
        }
        XCTAssertEqual(attempted, ["a", "b"])
    }

    @MainActor
    func testCancellationBetweenChordsStopsBeforeNextBoundary() async throws {
        let chords = try KeyboardCommandSequence.prepare("a b c d", systemKeyCombos: false)
        var attempted: [String] = []
        let task = Task { @MainActor in
            do {
                try await KeyboardCommandSequence.run(chords: chords) { batch in
                    attempted.append(contentsOf: batch.map(\.semanticKey))
                    withUnsafeCurrentTask { $0?.cancel() }
                }
                XCTFail("cancellation must prevent the next chord")
            } catch let error as CUError {
                XCTAssertEqual(error.code, "cancelled")
                XCTAssertTrue(error.message.contains("1 of 4"))
            } catch { XCTFail("unexpected error: \(error)") }
        }
        await task.value
        XCTAssertEqual(attempted, ["a"])
    }

    @MainActor
    func testSingleChordKeepsUnderlyingErrorWithoutMacroDecoration() async throws {
        let chords = try KeyboardCommandSequence.prepare("Return", systemKeyCombos: false)
        do {
            try await KeyboardCommandSequence.run(chords: chords) { _ in throw CUError("stale_process", "original error") }
            XCTFail("must propagate target refusal")
        } catch let error as CUError {
            XCTAssertEqual(error.code, "stale_process")
            XCTAssertEqual(error.message, "original error")
        }
    }
}
