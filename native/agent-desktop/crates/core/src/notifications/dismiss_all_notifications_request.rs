use crate::InteractionPolicy;

pub struct DismissAllNotificationsRequest<'a> {
    pub app_filter: Option<&'a str>,
    pub policy: InteractionPolicy,
}
