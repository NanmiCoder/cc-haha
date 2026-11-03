use crate::{
    AdapterError, AppError, CommandContext, InteractionPolicy, NotificationFilter,
    NotificationInfo, adapter::PlatformAdapter,
};

pub(crate) fn mutation_policy(context: &CommandContext) -> Result<InteractionPolicy, AppError> {
    let policy = context.physical_input_policy();
    if !policy.allow_focus_steal {
        return Err(AdapterError::policy_denied_for_policy(
            "Notification mutations open and focus the operating system notification surface",
            policy,
        )
        .into());
    }
    Ok(policy)
}

pub(crate) fn list_with_foreground_lease(
    filter: &NotificationFilter,
    deadline: crate::Deadline,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Vec<NotificationInfo>, AppError> {
    let policy = context.physical_input_policy();
    let lease = policy
        .allow_focus_steal
        .then(|| adapter.acquire_interaction_lease(deadline))
        .transpose()?;
    Ok(adapter.list_notifications(filter, policy, deadline, lease.as_ref())?)
}
