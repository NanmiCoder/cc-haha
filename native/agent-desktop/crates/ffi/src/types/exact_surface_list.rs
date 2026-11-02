use crate::types::AdExactSurfaceInfo;

/// Opaque list handle emitted by `ad_list_surfaces_exact`.
pub struct AdExactSurfaceList {
    pub(crate) items: Box<[AdExactSurfaceInfo]>,
}
