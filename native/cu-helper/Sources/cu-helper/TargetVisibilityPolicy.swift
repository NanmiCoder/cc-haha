import CoreGraphics
import Foundation

/// Explains a repeated window capture without turning ordinary occlusion into
/// an input failure.
///
/// The daemon keeps a desktop-independent SCStream subscribed to the target
/// window throughout a Computer Use turn. That gives Chromium/CEF a continuous
/// WindowServer consumer while another app fully covers it, while all input is
/// still addressed to the target process/window. Occlusion is therefore never
/// a reason to raise, activate, or reject a mutation.
enum TargetVisibilityPolicy {
    static func captureTargetStillMatches(
        snapshotWindowID: CGWindowID?,
        currentWindowID: CGWindowID?
    ) -> Bool {
        snapshotWindowID == currentWindowID
    }

    /// Once the daemon has a stream-capable provider, a covered-window read
    /// must never fall back to a one-shot compositor capture: those pixels can
    /// predate the action even though the Accessibility mutation succeeded.
    /// Older macOS versions without the provider keep their compatibility path.
    static func permitsOneShotFallback(
        windowIsCovered: Bool,
        streamProviderInstalled: Bool
    ) -> Bool {
        !windowIsCovered || !streamProviderInstalled
    }

    static func coveredCaptureNotice(liveStreamActive: Bool) -> String {
        if liveStreamActive {
            return """
            NOTE: Another application fully covers the target window. A \
            long-lived window stream remains subscribed while it is covered, \
            and this state uses a new on-demand window screenshot, not the \
            stream's cached frame or the visible desktop. Keep using app- and \
            window-targeted input without activating or raising the target. \
            An action receipt alone does not prove the application responded.
            """
        }
        return """
        NOTE: Another application fully covers the target window, and a fresh \
        live window-stream frame was unavailable for this read. A one-shot \
        screenshot is intentionally not used on stream-capable systems because \
        it may contain compositor-cached pixels. Coverage still does not block \
        Accessibility actions or app- and window-targeted input; continue \
        without activating or raising the target, and rely on the accessibility \
        state until the stream produces a fresh frame.
        """
    }

    static func identicalCaptureNotice(
        windowIsCovered: Bool,
        liveStreamActive: Bool,
        windowIsOffScreen: Bool = false
    ) -> String {
        let cause: String
        if windowIsOffScreen {
            // Coverage is measured on the shown Spaces only; a window on
            // another Space or of a hidden app is neither "covered" nor
            // "visible", and Chromium stops repainting it.
            cause = """
            The target window is not on a Space the user is looking at, where \
            Chromium and Electron apps stop repainting. Identical pixels do not \
            show whether the action worked; judge it from the accessibility state.
            """
        } else if liveStreamActive {
            cause = windowIsCovered
                ? """
                  The target is covered, but its long-lived window stream is \
                  still active, and a new on-demand screenshot contains no \
                  visible pixel change. This does not establish whether the \
                  app accepted the input or redrew its content.
                  """
                : """
                  The target window is not fully covered, and the new \
                  on-demand screenshot contains no visible pixel change.
                  """
        } else {
            cause = windowIsCovered
                ? """
                  A live window-stream frame was unavailable while the target \
                  was covered, so this fallback image may be stale. Coverage \
                  does not block app- and window-targeted input.
                  """
                : """
                  The target window is not fully covered, so coverage does not \
                  explain the identical pixels, and no visible pixel change was \
                  observed.
                  """
        }

        return """
        NOTE: This screenshot is byte-for-byte identical to the previous one. \
        \(cause)

        Do not blindly repeat the same toggle: a second play/pause press can \
        undo the first. Re-read the accessibility state, use a semantic action \
        when one is available, or continue with a different app-targeted step.
        """
    }
}
