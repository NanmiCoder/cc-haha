use super::stacked_window::StackedWindow;
use crate::tree::Extents;

/// The stacking order at one instant: managed clients bottom to top, the
/// current desktop, and the mapped override-redirect windows above the target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StackingSnapshot {
    pub(crate) current_desktop: Option<u32>,
    pub(crate) stack: Vec<StackedWindow>,
    pub(crate) override_redirect_above: Vec<Extents>,
    /// The part of those windows that takes pointer events, by window id, in
    /// root coordinates: their input region. A window whose region could not
    /// be read, and one with an empty region, contribute nothing.
    pub(crate) override_redirect_receiving: Vec<(u32, Extents)>,
    /// The titles of those windows that have one, by window id.
    pub(crate) override_redirect_names: Vec<(u32, String)>,
}
