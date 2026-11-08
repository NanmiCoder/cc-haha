use super::X11Client;

/// What the display server and its window manager could say. Anything but
/// `Ready` is the absence of evidence, never evidence of absence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum X11State {
    /// No display server answered in time, or the session is not X11.
    Unavailable,
    /// A server answered but no window manager publishes window properties.
    NoWindowManager,
    Ready {
        active: Option<u32>,
        clients: Vec<X11Client>,
    },
}
