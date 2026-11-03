use crate::{AppError, CommandContext, adapter::PlatformAdapter};
use serde_json::Value;

pub struct NotificationActionArgs {
    pub index: usize,
    pub action: String,
    pub expected_app: Option<String>,
    pub expected_title: Option<String>,
}

pub fn execute(
    args: NotificationActionArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let identity =
        super::notification_identity::required_identity(args.expected_app, args.expected_title)?;
    let policy = super::notification_policy::mutation_policy(context)?;
    let lease = crate::commands::helpers::acquire_interaction_lease(adapter)?;
    let result = adapter.notification_action(
        crate::NotificationActionRequest {
            index: args.index,
            identity: &identity,
            action_name: &args.action,
            policy,
        },
        &lease,
    )?;
    Ok(serde_json::to_value(result)?)
}
