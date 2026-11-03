use agent_desktop_core::WindowInfo;

use crate::system::x11::FrameFacts;

/// A window of the registry with what focus and surfaces need beside what is
/// reported.
#[derive(Debug, Clone)]
pub(crate) struct ListedWindow {
    pub(crate) app: usize,
    pub(crate) info: WindowInfo,
    pub(crate) active: bool,
    pub(crate) modal: bool,
    pub(crate) dialog: bool,
    pub(crate) frame: FrameFacts,
    pub(crate) sheet: bool,
    /// The window neither shows nor is iconified. A toolkit that keeps a
    /// top-level window for reuse leaves such a husk on the registry after
    /// it hides or closes.
    pub(crate) unshown: bool,
}
