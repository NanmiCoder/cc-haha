use crate::types::AdDisplayInfo;

/// Opaque list handle emitted by `ad_list_displays`.
pub struct AdDisplayList {
    pub(crate) items: Box<[AdDisplayInfo]>,
}
