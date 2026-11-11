import Foundation

/// Told to the model when the app it drives has no window on the Spaces the
/// user is looking at. Each reason has its own truth, measured on a real
/// machine, and a notice that claims more than that sends the model the wrong
/// way:
/// - Another Space (another desktop, or behind a fullscreen app such as our
///   own desktop window): clicks and keys still land, but Chromium stops
///   repainting, so the screenshot lags the page. A model that trusts those
///   pixels concludes its actions failed and repeats them.
/// - Hidden (⌘H): read as it is; the synthetic activation before an action
///   shows it again without taking the foreground.
/// - Parked: restored from the Dock, or shown after being hidden, while its
///   Space was not shown. Input did not land until the user visited that
///   Space, so actions are refused and the model must say so instead of
///   believing "Action completed".
enum OffScreenTargetAdvice {
    enum Reason: Equatable {
        case otherSpace
        case hidden
        case parked
    }

    static func reason(
        hasWindowOnScreen: Bool,
        appIsHidden: Bool,
        keyWindowIsParked: Bool
    ) -> Reason? {
        if keyWindowIsParked { return .parked }
        if hasWindowOnScreen { return nil }
        return appIsHidden ? .hidden : .otherSpace
    }

    static func notice(for reason: Reason) -> String {
        switch reason {
        case .otherSpace:
            return """
            NOTE: The target window is on a Space the user is not looking at \
            (another desktop, or behind a fullscreen app). Keep working in the \
            background: clicks, typing, scrolling and element actions are still \
            delivered to this window without bringing the app forward. Do not \
            activate, raise, or reopen the app to make it visible.

            \(staleScreenshot)
            """
        case .hidden:
            return """
            NOTE: The target app is hidden (⌘H) and was read as it is. Your next \
            action only shows it again, without bringing it forward or taking \
            the user's keyboard; read its state after that, then act. Do not \
            activate or raise it. If its window then sits on a Space the user \
            is not looking at, actions are refused until the user shows that \
            Space.

            \(staleScreenshot)
            """
        case .parked:
            return """
            NOTE: The target window came back onto a Space the user is not \
            looking at (restored from the Dock, or shown after being hidden). \
            macOS does not deliver clicks or keys to it until that Space is \
            shown, so actions on it are refused. Tell the user the app is \
            waiting on another desktop; do not retry, and do not activate or \
            raise the app.
            """
        }
    }

    /// Overrides the general "two unchanged screenshots mean the approach is
    /// wrong" rule, which assumes the picture is live.
    private static let staleScreenshot = """
    While the window is not visible, Chromium and Electron apps stop \
    repainting, so the screenshot above may be older than the accessibility \
    state. Trust the accessibility tree; an unchanged screenshot here does not \
    mean an action failed or that the approach is wrong. If the tree is a bare \
    shell — window frame and menu bar only — results cannot be confirmed until \
    the window is visible again; say so instead of repeating actions.
    """
}
