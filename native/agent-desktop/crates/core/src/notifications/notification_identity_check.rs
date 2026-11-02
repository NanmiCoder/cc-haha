use crate::{AdapterError, ErrorCode, NotificationIdentity, NotificationInfo};

/// Confirms the notification read at `index` is still the one the caller
/// observed. An absent or empty identity accepts any entry; otherwise the
/// expected app and title must match, and a mismatch means the list moved.
pub fn verify_notification_identity(
    index: usize,
    identity: Option<&NotificationIdentity>,
    info: &NotificationInfo,
) -> Result<(), AdapterError> {
    if identity.is_none_or(|value| value.is_empty() || value.matches(info)) {
        return Ok(());
    }
    Err(AdapterError::new(
        ErrorCode::NotificationNotFound,
        format!("Notification at index {index} no longer matches its expected identity"),
    )
    .with_suggestion("Run list-notifications again and retry with the freshly-observed index"))
}

#[cfg(test)]
#[path = "notification_identity_check_tests.rs"]
mod tests;
