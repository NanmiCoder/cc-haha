use agent_desktop_core::{AdapterError, Deadline, ErrorCode};

#[test]
fn transient_element_error_is_skipped_so_the_scan_continues() {
    let error = AdapterError::new(ErrorCode::AppUnresponsive, "element read failed");

    let result = super::tolerate_element_error(error, Deadline::standard().expect("deadline"));

    assert!(result.is_ok());
}

#[test]
fn permission_error_aborts_the_scan() {
    let result = super::tolerate_element_error(
        AdapterError::permission_denied(),
        Deadline::standard().expect("deadline"),
    );

    assert_eq!(
        result.expect_err("permission denial must abort").code,
        ErrorCode::PermDenied
    );
}

#[test]
fn row_description_maps_named_notification_fields() {
    let texts = [
        "Probe title".to_owned(),
        "Probe body".to_owned(),
        "now".to_owned(),
    ];
    let parsed = super::parse_row_description("Script Editor, Probe title, Probe body", &texts)
        .expect("description");

    assert_eq!(parsed.0, "Script Editor");
    assert_eq!(parsed.1, "Probe title");
    assert_eq!(parsed.2.as_deref(), Some("Probe body"));
}

#[test]
fn two_part_description_keeps_the_application_as_the_title() {
    let texts = ["Probe body".to_owned(), "now".to_owned()];
    let parsed =
        super::parse_row_description("Script Editor, Probe body", &texts).expect("description");

    assert_eq!(parsed.0, "Script Editor");
    assert_eq!(parsed.1, "Script Editor");
    assert_eq!(parsed.2.as_deref(), Some("Probe body"));
}

#[test]
fn description_correlation_preserves_commas_in_title_and_body() {
    let texts = [
        "Hello, world".to_owned(),
        "Body, with, commas".to_owned(),
        "2m ago".to_owned(),
    ];
    let parsed =
        super::parse_row_description("Script Editor, Hello, world, Body, with, commas", &texts)
            .expect("description");

    assert_eq!(parsed.0, "Script Editor");
    assert_eq!(parsed.1, "Hello, world");
    assert_eq!(parsed.2.as_deref(), Some("Body, with, commas"));
}

#[test]
fn only_identified_notification_action_buttons_are_reported() {
    assert!(super::is_notification_action(Some("action_button")));
    assert!(!super::is_notification_action(None));
    assert!(!super::is_notification_action(Some("calendar-event")));
    assert!(!super::is_notification_action(Some("close_button")));
}
