use crate::{AppError, NotificationFilter, adapter::PlatformAdapter, context::CommandContext};
use serde_json::{Value, json};

pub struct ListNotificationsArgs {
    pub app: Option<String>,
    pub text: Option<String>,
    pub limit: Option<usize>,
}

pub fn execute(
    args: ListNotificationsArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let filter = NotificationFilter {
        app: args.app,
        text: args.text,
        limit: args.limit,
    };
    let notifications = super::notification_policy::list_with_foreground_lease(
        &filter,
        crate::Deadline::standard()?,
        adapter,
        context,
    )?;
    Ok(json!({
        "count": notifications.len(),
        "notifications": notifications,
    }))
}
