use super::LocatorMatchData;
use crate::Rect;
use crate::refs::RefEntry;

pub struct LocatorMatch {
    pub data: LocatorMatchData,
    pub document_order: u32,
    pub(crate) entry: RefEntry,
    /// The node's rectangle in screen coordinates, the frame a pointer is
    /// aimed in. The entry holds the rectangle a ref re-identifies the node
    /// by, which a toolkit that reports no global position measures in the
    /// window, so a response that shows geometry reads this one.
    pub(crate) screen_bounds: Option<Rect>,
    /// Whether the observation that found this node read every field a ref
    /// and the response need, so reading the node again would only repeat it.
    pub(crate) fully_observed: bool,
}

impl LocatorMatch {
    pub fn into_entry(self) -> RefEntry {
        self.entry
    }
}
