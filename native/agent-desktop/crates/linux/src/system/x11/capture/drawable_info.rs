use super::map_state::MapState;
use crate::system::x11::window::frame_extents::FrameExtents;
use crate::tree::Extents;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DrawableInfo {
    pub(crate) rect: Extents,
    pub(crate) parent: Option<u32>,
    pub(crate) depth: u8,
    pub(crate) map_state: MapState,
    pub(crate) override_redirect: bool,
    /// `_GTK_FRAME_EXTENTS`: the client-side shadow a GTK window draws
    /// inside its own drawable, absent for a window with none.
    pub(crate) shadow: Option<FrameExtents>,
}
