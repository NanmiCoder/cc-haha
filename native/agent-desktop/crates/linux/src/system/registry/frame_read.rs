use super::registry_frames::RootRead;
use crate::tree::RawNode;

/// The frames read for one application root and how far the read got.
pub(crate) struct FrameRead {
    pub(crate) nodes: Vec<RawNode>,
    pub(crate) read: RootRead,
}

impl FrameRead {
    pub(in crate::system) fn empty(read: RootRead) -> Self {
        Self {
            nodes: Vec::new(),
            read,
        }
    }
}
