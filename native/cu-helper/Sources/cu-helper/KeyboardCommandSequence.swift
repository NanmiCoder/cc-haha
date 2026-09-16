import Foundation

/// Preflight a complete macro before entering the per-command input boundary.
enum KeyboardCommandSequence {
    static let maximumChordCount = 128

    static func prepare(_ sequence: String, systemKeyCombos: Bool) throws -> [KeyMapping.Chord] {
        let chords = try KeyMapping.parse(sequence)
        guard chords.count <= maximumChordCount else {
            throw CUError("bad_payload", "press_key accepts at most \(maximumChordCount) chords; no input was sent")
        }
        try SystemKeyPolicy.enforce(sequence: sequence, granted: systemKeyCombos)
        return chords
    }

    /// Each callback is one complete existing native command boundary, including
    /// its foreground lease, focus preparation and finalization. Awaiting only
    /// a yield between CGEvents would not reproduce that boundary. One chord's
    /// down/up group is still fully allocated before it is posted.
    @MainActor
    static func run(
        chords: [KeyMapping.Chord],
        perform: @MainActor ([KeyMapping.Chord]) async throws -> Void
    ) async throws {
        var completed = 0
        var inFlight = false
        do {
            for chord in chords {
                try Task.checkCancellation()
                inFlight = true
                try await perform([chord])
                completed += 1
                inFlight = false
            }
            try Task.checkCancellation()
        } catch {
            // Keep the established single-key error contract, including paste's
            // clipboard validation. A macro can have a completed prefix even
            // when its finalization refuses, so do not invite whole-macro retry.
            guard chords.count > 1 else { throw error }
            let code = (error as? CUError)?.code
                ?? (error is CancellationError ? "cancelled" : "keyboard_sequence_failed")
            let delivery = inFlight ? " The failed chord may already have been delivered." : ""
            throw CUError(
                code,
                "press_key stopped after \(completed) of \(chords.count) chords completed.\(delivery) "
                    + "Inspect the current state before continuing; do not replay the completed prefix. "
                    + "Cause: \(error.localizedDescription)"
            )
        }
    }
}
