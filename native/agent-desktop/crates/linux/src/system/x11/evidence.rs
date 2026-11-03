/// What the window manager says about which listed window is active, in terms
/// of the windows being listed. Everything but `Frame` is the absence of a
/// claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum X11Evidence {
    /// No window manager answered.
    Unavailable,
    /// The window manager names no active window.
    NoActive,
    /// The active window is exactly this listed window.
    Frame(usize),
    /// The active window could belong to more than one listed window.
    Ambiguous,
    /// The active window belongs to no listed window.
    Unmapped,
}
