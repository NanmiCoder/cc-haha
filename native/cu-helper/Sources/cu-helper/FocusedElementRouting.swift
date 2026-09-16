import Foundation

/// Select focus only from the requested application. The callbacks make the
/// background/foreground decision testable without contacting an AX server.
enum FocusedElementRouting {
    @MainActor
    static func select<Element>(
        targetPID: pid_t,
        frontmostPID: pid_t?,
        systemFocusedPID: () -> pid_t?,
        systemFocusedElement: () -> Element?,
        targetFocusedElement: () -> Element?
    ) -> Element? {
        // Reading global AX focus can wait for an unrelated foreground app's
        // AX server. A known background target needs only its own focus tree.
        // Unknown frontmost identity retains the original global query, and
        // the actual AX PID remains authoritative if focus changes meanwhile.
        if (frontmostPID == nil || frontmostPID == targetPID),
           systemFocusedPID() == targetPID,
           let element = systemFocusedElement() {
            return element
        }
        return targetFocusedElement()
    }
}
