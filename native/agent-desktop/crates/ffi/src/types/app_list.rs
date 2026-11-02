use crate::types::app_info::AdAppInfo;

/// Opaque list handle emitted by `ad_list_apps`.
pub struct AdAppList {
    pub(crate) items: Box<[AdAppInfo]>,
}
