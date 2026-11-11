use crate::{AppError, adapter::PlatformAdapter, context::CommandContext};
use serde_json::{Value, json};

pub struct DismissNotificationArgs {
    pub index: usize,
    pub app: Option<String>,
    pub expected_app: Option<String>,
    pub expected_title: Option<String>,
}

pub fn execute(
    args: DismissNotificationArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let identity =
        super::notification_identity::required_identity(args.expected_app, args.expected_title)?;
    let policy = super::notification_policy::mutation_policy(context)?;
    let lease = crate::commands::helpers::acquire_interaction_lease(adapter)?;
    let dismissed = adapter.dismiss_notification(
        crate::DismissNotificationRequest {
            index: args.index,
            app_filter: args.app.as_deref(),
            identity: &identity,
            policy,
        },
        &lease,
    )?;
    Ok(json!({
        "dismissed": dismissed,
    }))
}
