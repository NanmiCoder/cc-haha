use super::FrameExtents;
use crate::tree::Extents;

/// One top-level window the window manager manages. `bounds` is the client
/// rectangle in root coordinates, inside the frame `extents` describes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct X11Client {
    pub(crate) id: u32,
    pub(crate) pid: Option<u32>,
    pub(crate) title: String,
    pub(crate) extents: Option<FrameExtents>,
    pub(crate) bounds: Option<Extents>,
    pub(crate) hidden: bool,
    /// `_GTK_FRAME_EXTENTS` as left, top, right, bottom: the client-side
    /// shadow a GTK window draws inside its client. The toolkit's window
    /// coordinates of GTK 4 start after the left and top; GTK 3 reports the
    /// whole client. Zero for a window with no shadow.
    pub(crate) shadow: (i32, i32, i32, i32),
}
