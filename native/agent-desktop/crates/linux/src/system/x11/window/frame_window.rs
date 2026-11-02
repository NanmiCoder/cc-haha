use super::window_x11_state::WindowX11State;

/// What the display server says about the window of one listed frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FrameWindow {
    /// No client could be named: the session is not X11, no manager answers,
    /// or the frame matches no client.
    Unknown,
    /// Several clients answer to the frame and nothing tells them apart. The
    /// flag is what they all say about being hidden, when they agree.
    Tied { hidden: Option<bool> },
    /// The one client of the frame, and its state.
    Client(WindowX11State),
}
