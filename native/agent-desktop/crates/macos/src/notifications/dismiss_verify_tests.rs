use agent_desktop_core::{AdapterError, Deadline, ErrorCode, NotificationInfo};

#[test]
fn acknowledged_strategy_is_not_success_while_the_row_remains() {
    let result = super::wait_with(|| Ok(true), Deadline::after(0).expect("deadline"));

    assert_eq!(
        result.expect_err("present row must not verify").code,
        ErrorCode::Timeout
    );
}

#[test]
fn acknowledged_strategy_succeeds_only_after_reobservation_finds_no_row() {
    let mut observations = [true, false].into_iter();
    let result = super::wait_with(
        || -> Result<bool, AdapterError> { Ok(observations.next().unwrap_or(false)) },
        Deadline::standard().expect("deadline"),
    );

    assert!(result.expect("verification succeeds"));
}

#[test]
fn tolerated_native_error_succeeds_when_reobservation_proves_removal() {
    let result = super::verified_after_strategy(
        Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "target disappeared during AXDismiss",
        )),
        Deadline::standard().expect("deadline"),
        || Ok(true),
    );

    assert!(result.expect("verified removal must dominate native acknowledgement"));
}

#[test]
fn fallback_identity_includes_the_body() {
    let original = NotificationInfo {
        index: 1,
        app_name: "Calendar".to_owned(),
        title: "Reminder".to_owned(),
        body: Some("First".to_owned()),
        actions: Vec::new(),
    };
    let mut other = original.clone();
    other.index = 2;
    other.body = Some("Second".to_owned());

    assert!(!super::same_info(&original, &other));
}
