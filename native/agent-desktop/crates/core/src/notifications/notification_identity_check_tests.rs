use super::verify_notification_identity;
use crate::{ErrorCode, NotificationIdentity, NotificationInfo};

fn info(app: &str, title: &str) -> NotificationInfo {
    NotificationInfo {
        index: 3,
        app_name: app.into(),
        title: title.into(),
        body: None,
        actions: vec![],
    }
}

fn identity(app: Option<&str>, title: Option<&str>) -> NotificationIdentity {
    NotificationIdentity {
        expected_app: app.map(String::from),
        expected_title: title.map(String::from),
    }
}

#[test]
fn absent_identity_accepts_any_entry() {
    assert!(verify_notification_identity(3, None, &info("Calendar", "Meeting")).is_ok());
}

#[test]
fn empty_identity_accepts_any_entry() {
    let empty = identity(Some(""), None);
    assert!(verify_notification_identity(3, Some(&empty), &info("Calendar", "Meeting")).is_ok());
    let default = NotificationIdentity::default();
    assert!(verify_notification_identity(3, Some(&default), &info("Calendar", "Meeting")).is_ok());
}

#[test]
fn matching_identity_accepts_the_entry() {
    let expected = identity(Some("Calendar"), Some("Meeting"));
    assert!(verify_notification_identity(3, Some(&expected), &info("Calendar", "Meeting")).is_ok());
}

#[test]
fn mismatched_identity_reports_notification_not_found_with_the_index() {
    let expected = identity(Some("Calendar"), Some("Meeting"));
    let error = verify_notification_identity(3, Some(&expected), &info("Calendar", "Reminder"))
        .expect_err("a different title must not verify");
    assert_eq!(error.code, ErrorCode::NotificationNotFound);
    assert_eq!(
        error.message,
        "Notification at index 3 no longer matches its expected identity"
    );
    assert_eq!(
        error.suggestion.as_deref(),
        Some("Run list-notifications again and retry with the freshly-observed index")
    );
}
