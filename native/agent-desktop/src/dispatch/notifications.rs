use agent_desktop_core::{
    AppError, PlatformAdapter,
    commands::{
        dismiss_all_notifications, dismiss_notification, list_notifications, notification_action,
    },
    context::CommandContext,
};
use serde_json::Value;

use crate::cli_args::notifications::{
    DismissAllNotificationsCliArgs, DismissNotificationCliArgs, ListNotificationsCliArgs,
    NotificationActionCliArgs,
};

pub(super) fn list(
    args: ListNotificationsCliArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    list_notifications::execute(
        list_notifications::ListNotificationsArgs {
            app: args.app,
            text: args.text,
            limit: args.limit,
        },
        adapter,
        context,
    )
}

pub(super) fn dismiss(
    args: DismissNotificationCliArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    dismiss_notification::execute(
        dismiss_notification::DismissNotificationArgs {
            index: notification_index(args.index)?,
            app: args.app,
            expected_app: args.expected_app,
            expected_title: args.expected_title,
        },
        adapter,
        context,
    )
}

pub(super) fn dismiss_all(
    args: DismissAllNotificationsCliArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    dismiss_all_notifications::execute(
        dismiss_all_notifications::DismissAllNotificationsArgs { app: args.app },
        adapter,
        context,
    )
}

pub(super) fn action(
    args: NotificationActionCliArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    notification_action::execute(
        notification_action::NotificationActionArgs {
            index: notification_index(args.index)?,
            action: args.action,
            expected_app: args.expected_app,
            expected_title: args.expected_title,
        },
        adapter,
        context,
    )
}

fn notification_index(index: u64) -> Result<usize, AppError> {
    if index == 0 {
        return Err(AppError::invalid_input(
            "Notification index is 1-based and must be greater than zero",
        ));
    }
    usize::try_from(index).map_err(|_| AppError::invalid_input("Notification index is too large"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_noop_ops::NoopAdapter;

    #[test]
    fn dismiss_notification_rejects_zero_index_before_adapter() {
        let err = dismiss(
            DismissNotificationCliArgs {
                index: 0,
                app: None,
                expected_app: None,
                expected_title: None,
            },
            &NoopAdapter,
            &CommandContext::default(),
        )
        .unwrap_err();

        assert_eq!(err.code(), "INVALID_ARGS");
    }

    #[test]
    fn notification_action_rejects_zero_index_before_adapter() {
        let err = action(
            NotificationActionCliArgs {
                index: 0,
                action: "Reply".into(),
                expected_app: None,
                expected_title: None,
            },
            &NoopAdapter,
            &CommandContext::default(),
        )
        .unwrap_err();

        assert_eq!(err.code(), "INVALID_ARGS");
    }
}
