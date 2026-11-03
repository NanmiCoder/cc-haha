/// The border a window manager draws around a client, in pixels, in the order
/// `_NET_FRAME_EXTENTS` defines: left, right, top, bottom.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct FrameExtents {
    pub(crate) left: u32,
    pub(crate) right: u32,
    pub(crate) top: u32,
    pub(crate) bottom: u32,
}
