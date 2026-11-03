use crate::{AppError, NotificationIdentity};

pub(crate) fn required_identity(
    expected_app: Option<String>,
    expected_title: Option<String>,
) -> Result<NotificationIdentity, AppError> {
    let identity = NotificationIdentity {
        expected_app,
        expected_title,
    };
    if identity.is_empty() {
        return Err(AppError::invalid_input_with_suggestion(
            "Notification mutations require --expected-app or --expected-title",
            "Pass identity fields from the same list-notifications result to prevent acting on a reordered notification.",
        ));
    }
    Ok(identity)
}

#[cfg(test)]
#[path = "notification_identity_tests.rs"]
mod tests;
