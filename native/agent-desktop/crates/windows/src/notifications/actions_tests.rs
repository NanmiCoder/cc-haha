use agent_desktop_core::{ErrorCode, InteractionPolicy, NotificationIdentity, NotificationInfo};

use super::{
    dismiss_all_failures, is_sole_target, require_foreground_policy, unknown_action_error,
    verify_notification_identity,
};

fn info(app: &str, title: &str) -> NotificationInfo {
    NotificationInfo {
        index: 1,
        app_name: app.into(),
        title: title.into(),
        body: None,
        actions: Vec::new(),
    }
}

#[test]
fn an_empty_identity_defers_to_the_index() {
    let identity = NotificationIdentity::default();

    assert!(verify_notification_identity(1, Some(&identity), &info("App A", "Reminder")).is_ok());
    assert!(verify_notification_identity(1, None, &info("App A", "Reminder")).is_ok());
}

#[test]
fn a_matching_identity_is_accepted() {
    let identity = NotificationIdentity {
        expected_app: Some("App A".into()),
        expected_title: Some("Reminder".into()),
    };

    assert!(verify_notification_identity(1, Some(&identity), &info("App A", "Reminder")).is_ok());
}

#[test]
fn a_mismatched_identity_is_notification_not_found_and_names_only_the_index() {
    let identity = NotificationIdentity {
        expected_app: Some("App A".into()),
        expected_title: Some("Reminder".into()),
    };

    let error =
        verify_notification_identity(2, Some(&identity), &info("App B", "Moved in underneath"))
            .expect_err("the surface reordered under the caller");

    assert_eq!(error.code, ErrorCode::NotificationNotFound);
    assert!(error.message.contains("index 2"));
    assert!(
        !error.message.contains("App B"),
        "the mismatch message is built from the index alone and must never carry the entry that actually sits there"
    );
    assert!(!error.message.contains("Moved in underneath"));
}

#[test]
fn a_title_only_identity_is_verified_against_the_title() {
    let identity = NotificationIdentity {
        expected_app: None,
        expected_title: Some("Reminder".into()),
    };

    assert!(verify_notification_identity(1, Some(&identity), &info("App A", "Reminder")).is_ok());
    assert!(verify_notification_identity(1, Some(&identity), &info("App A", "Other")).is_err());
}

#[test]
fn a_strict_headless_caller_is_policy_denied_before_anything_raises() {
    let error = require_foreground_policy(InteractionPolicy::headless())
        .expect_err("headless policy must refuse");

    assert_eq!(error.code, ErrorCode::PolicyDenied);
}

#[test]
fn a_policy_that_permits_the_foreground_change_proceeds() {
    assert!(require_foreground_policy(InteractionPolicy::focus_fallback()).is_ok());
    assert!(require_foreground_policy(InteractionPolicy::headed()).is_ok());
}

fn entry(index: usize, app: &str, title: &str) -> NotificationInfo {
    NotificationInfo {
        index,
        app_name: app.into(),
        title: title.into(),
        body: None,
        actions: Vec::new(),
    }
}

#[test]
fn a_filtered_dismiss_all_that_removes_its_target_leaves_another_apps_entry_unreported() {
    let captured = vec![entry(1, "App A", "cleared"), entry(2, "App B", "untouched")];
    let current = vec![entry(2, "App B", "untouched")];

    let failures = dismiss_all_failures(&captured, &current, &[]);

    assert_eq!(
        failures.len(),
        1,
        "App A's entry left, so only App B's untouched entry is a survivor"
    );
    assert!(failures[0].contains("#2"));
    assert!(
        !failures.iter().any(|failure| failure.contains("#1")),
        "the entry that actually left must never appear as a failure"
    );
}

#[test]
fn a_recorded_invoke_error_names_its_own_reason_instead_of_the_generic_survivor_message() {
    let captured = vec![entry(1, "App A", "refused"), entry(2, "App B", "untouched")];
    let current = vec![entry(1, "App A", "refused"), entry(2, "App B", "untouched")];
    let invoke_errors = vec![(1, "the dismiss control could not be invoked".to_string())];

    let failures = dismiss_all_failures(&captured, &current, &invoke_errors);

    assert_eq!(failures.len(), 2);
    let for_one = failures
        .iter()
        .find(|failure| failure.contains("#1"))
        .expect("index 1 is reported");
    assert!(
        for_one.contains("the dismiss control could not be invoked"),
        "the invoke's own error must survive into the failure line, not be discarded"
    );
    let for_two = failures
        .iter()
        .find(|failure| failure.contains("#2"))
        .expect("index 2 is reported");
    assert!(
        for_two.contains("still present"),
        "an entry with no recorded invoke error falls back to the generic survivor message"
    );
}

#[test]
fn an_invoke_error_recorded_for_an_entry_that_still_left_is_never_reported() {
    let captured = vec![
        entry(1, "App A", "left anyway"),
        entry(2, "App B", "stayed"),
    ];
    let current = vec![entry(2, "App B", "stayed")];
    let invoke_errors = vec![(1, "transient invoke error".to_string())];

    let failures = dismiss_all_failures(&captured, &current, &invoke_errors);

    assert_eq!(
        failures.len(),
        1,
        "the settle read proves index 1 left despite its invoke error, so it is dismissed, not failed"
    );
    assert!(!failures[0].contains("transient invoke error"));
    assert!(failures[0].contains("#2"));
}

#[test]
fn the_clear_all_substitute_fires_only_on_exactly_one_matching_entry() {
    let target = info("Toaster", "Build finished");
    let foreign = info("Toaster", "Build finished (not the staged entry)");

    assert!(is_sole_target(&target, std::slice::from_ref(&target)));
    assert!(!is_sole_target(&target, std::slice::from_ref(&foreign)));
    assert!(!is_sole_target(&target, &[]));
    assert!(!is_sole_target(&target, &[target.clone(), foreign]));
}

#[test]
fn an_unknown_action_name_is_refused_naming_it_and_nothing_was_delivered() {
    let error = unknown_action_error("agent-desktop-no-such-action", 3);

    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert!(error.message.contains("agent-desktop-no-such-action"));
    assert_eq!(
        error.disposition,
        agent_desktop_core::DeliverySemantics::not_delivered()
    );
}

#[test]
fn the_dismiss_reaches_the_windows_override_not_the_trait_default() {
    use agent_desktop_core::{Deadline, DismissNotificationRequest, InteractionLease, SystemOps};

    let adapter = crate::adapter::WindowsAdapter::new();
    let lease = InteractionLease::guarded(Deadline::detached_after(5_000).expect("deadline"), ())
        .expect("lease");
    let identity = NotificationIdentity::default();

    let error = SystemOps::dismiss_notification(
        &adapter,
        DismissNotificationRequest {
            index: 1,
            app_filter: None,
            identity: &identity,
            policy: InteractionPolicy::headless(),
        },
        &lease,
    )
    .expect_err("the headless floor refuses before anything is raised");

    assert_eq!(
        error.code,
        ErrorCode::PolicyDenied,
        "the trait default would answer PLATFORM_NOT_SUPPORTED instead"
    );
}
