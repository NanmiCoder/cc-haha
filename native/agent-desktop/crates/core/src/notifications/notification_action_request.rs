use crate::{InteractionPolicy, NotificationIdentity};

pub struct NotificationActionRequest<'a> {
    pub index: usize,
    pub identity: &'a NotificationIdentity,
    pub action_name: &'a str,
    pub policy: InteractionPolicy,
}
