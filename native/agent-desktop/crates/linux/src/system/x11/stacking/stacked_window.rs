use crate::system::x11::FrameExtents;
use crate::system::x11::window::desktop_placement::DesktopPlacement;
use crate::system::x11::window::window_flags::WindowFlags;
use crate::system::x11::window::window_kind::WindowKind;
use crate::tree::Extents;

/// One managed client in the stacking order: its flags, desktop, type, client
/// rectangle in root coordinates and the border drawn around it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StackedWindow {
    pub(crate) id: u32,
    pub(crate) flags: WindowFlags,
    pub(crate) desktop: DesktopPlacement,
    pub(crate) kind: WindowKind,
    pub(crate) client: Extents,
    pub(crate) extents: FrameExtents,
    pub(crate) shadow: (i32, i32, i32, i32),
}
