use super::{LocatorMaterialization, LocatorSelection};
use crate::Deadline;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocatorResolveRequest {
    pub selection: LocatorSelection,
    pub deadline: Deadline,
    pub max_raw_depth: u8,
    pub materialization: LocatorMaterialization,
    /// Overrides the surface implied by the root. A window root otherwise means
    /// the window surface, which leaves menu bars and other overlays
    /// unreachable by a targeted search.
    pub surface: Option<crate::SnapshotSurface>,
}
