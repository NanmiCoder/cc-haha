use crate::types::AdExactWindowInfo;

/// Opaque list handle emitted by ad_list_windows_exact.
pub struct AdExactWindowList {
    pub(crate) items: Box<[AdExactWindowInfo]>,
}
