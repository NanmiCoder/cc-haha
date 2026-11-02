use crate::{InteractionPolicy, NotificationIdentity};

pub struct DismissNotificationRequest<'a> {
    pub index: usize,
    pub app_filter: Option<&'a str>,
    pub identity: &'a NotificationIdentity,
    pub policy: InteractionPolicy,
}
