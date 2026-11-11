pub(crate) mod display_bounds;
pub(super) mod extents;
pub(crate) mod frame_geometry;
pub(super) mod node_position;
pub(crate) mod offscreen;
pub(super) mod placed_states;
pub(super) mod popup_position;

use super::Extents;
use super::surfaces::window_tie::WindowTie;
use crate::system::process::toolkit_id::ToolkitId;
use crate::system::x11::window::window_x11_state::WindowX11State;

/// Where a node sits relative to its window, as far as it could be read.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct Placement {
    pub(crate) node: Option<Extents>,
    pub(crate) frame: Option<Extents>,
    pub(crate) container: Option<Extents>,
    pub(crate) frame_iconified: Option<bool>,
    pub(crate) toolkit: ToolkitId,
    /// The origin of a uniquely matched, viewable override-redirect popup,
    /// relative to its AT-SPI frame's window-coordinate rectangle.
    pub(crate) popup_origin: Option<(i32, i32)>,
    pub(crate) x11: Option<WindowX11State>,
    pub(crate) displays: Option<Vec<Extents>>,
    pub(crate) wayland_unplaced: bool,
    /// The frame maps to several display windows that nothing tells apart.
    pub(crate) tie: Option<WindowTie>,
}

pub(crate) mod popup_frame;
pub(super) mod snapshot_visibility;
pub(crate) mod visibility;
