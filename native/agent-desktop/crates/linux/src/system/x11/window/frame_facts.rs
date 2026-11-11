use crate::tree::Extents;

/// What is known of a listed window for finding its X11 client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FrameFacts {
    pub(crate) pid: u32,
    pub(crate) title: String,
    pub(crate) extents: Option<Extents>,
    pub(crate) global_position: bool,
    /// A complete application-frame read proved this is an unnamed GTK4
    /// modal panel whose size no other accessible window can claim.
    pub(crate) size_identity: bool,
}
