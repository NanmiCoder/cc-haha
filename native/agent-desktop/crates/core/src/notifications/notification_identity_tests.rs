use crate::{NotificationIdentity, NotificationInfo};

fn sample_info(app: &str, title: &str) -> NotificationInfo {
    NotificationInfo {
        index: 1,
        app_name: app.into(),
        title: title.into(),
        body: None,
        actions: vec![],
    }
}

#[test]
fn default_is_empty_and_matches_everything() {
    let identity = NotificationIdentity::default();
    assert!(identity.is_empty());
    assert!(identity.matches(&sample_info("Messages", "Hi")));
    assert!(identity.matches(&sample_info("Slack", "New")));
}

#[test]
fn empty_string_fields_do_not_form_an_identity() {
    let identity = NotificationIdentity {
        expected_app: Some(String::new()),
        expected_title: None,
    };
    assert!(identity.is_empty());
}

#[test]
fn present_fields_must_match() {
    let app_only = NotificationIdentity {
        expected_app: Some("Messages".into()),
        expected_title: None,
    };
    assert!(app_only.matches(&sample_info("Messages", "anything")));
    assert!(!app_only.matches(&sample_info("Slack", "anything")));

    let title_only = NotificationIdentity {
        expected_app: None,
        expected_title: Some("Meeting".into()),
    };
    assert!(title_only.matches(&sample_info("Calendar", "Meeting")));
    assert!(!title_only.matches(&sample_info("Calendar", "Reminder")));

    let both = NotificationIdentity {
        expected_app: Some("Calendar".into()),
        expected_title: Some("Meeting".into()),
    };
    assert!(both.matches(&sample_info("Calendar", "Meeting")));
    assert!(!both.matches(&sample_info("Calendar", "Other")));
    assert!(!both.matches(&sample_info("Other", "Meeting")));
}
