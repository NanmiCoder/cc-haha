use crate::types::notification_info::AdNotificationInfo;

/// Opaque notification list returned by `ad_list_notifications`.
pub struct AdNotificationList {
    #[allow(dead_code)]
    pub(crate) items: Box<[AdNotificationInfo]>,
}
