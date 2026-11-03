use agent_desktop_core::{AppInfo, AppPresentation, ErrorCode};

use super::{missing_connection, one_entry_per_process, scoped_outcome};

fn app() -> AppInfo {
    AppInfo {
        name: "gnome-calculator".to_owned(),
        pid: 5.into(),
        bundle_id: None,
        process_instance: Some("b:1".to_owned()),
        presentation: None,
    }
}

#[test]
fn a_registry_match_is_returned_without_scanning_proc() {
    let found = scoped_outcome(vec![app()], "gnome-calculator", |_| {
        panic!("proc must not be scanned")
    })
    .expect("matched");
    assert_eq!(found.len(), 1);
}

#[test]
fn a_running_process_off_the_bus_is_app_not_found_naming_the_connection() {
    let error = scoped_outcome(Vec::new(), "firefox", |_| Some((77, "firefox".to_owned())))
        .expect_err("diagnostic");
    assert_eq!(error.code, ErrorCode::AppNotFound);
    assert_eq!(
        error.disposition,
        agent_desktop_core::DeliverySemantics::not_delivered()
    );
    assert!(error.message.contains("not on the accessibility bus"));
    assert!(error.message.contains("77"));
    let advice = error.suggestion.clone().expect("a recovery hint");
    assert!(advice.contains("--force-renderer-accessibility"));
    assert!(advice.contains("--no-sandbox"));
    assert!(advice.contains("QT_ACCESSIBILITY=1"));
    assert!(!advice.contains("A Chromium or Electron app needs ACCESSIBILITY_ENABLED=1"));
    let details = error.details.expect("details");
    assert_eq!(details["pid"], 77);
}

#[test]
fn a_name_nothing_matches_is_the_ordinary_empty_answer() {
    let found = scoped_outcome(Vec::new(), "nothing", |_| None).expect("empty");
    assert!(found.is_empty());
}

fn entry(pid: u32, instance: &str, presentation: AppPresentation) -> AppInfo {
    AppInfo {
        pid: pid.into(),
        process_instance: Some(instance.to_owned()),
        presentation: Some(presentation),
        ..app()
    }
}

#[test]
fn two_connections_of_one_process_list_once_as_foreground_when_either_has_windows() {
    let merged = one_entry_per_process(vec![
        entry(9, "b:1", AppPresentation::Background),
        entry(9, "b:1", AppPresentation::Foreground),
    ]);
    assert_eq!(merged.len(), 1);
    assert_eq!(merged[0].presentation, Some(AppPresentation::Foreground));
}

#[test]
fn processes_that_differ_in_pid_or_start_time_stay_separate() {
    let merged = one_entry_per_process(vec![
        entry(9, "b:1", AppPresentation::Foreground),
        entry(10, "b:1", AppPresentation::Foreground),
        entry(9, "b:2", AppPresentation::Foreground),
    ]);
    assert_eq!(merged.len(), 3);
}

#[test]
fn a_process_named_like_the_shell_gets_no_shell_identity_without_bus_ownership() {
    let error = missing_connection("gnome-shell", 2012, "gnome-shell");
    assert_eq!(error.code, ErrorCode::AppNotFound);
    assert!(error.message.contains("not on the accessibility bus"));
    let advice = error.suggestion.expect("a suggestion");
    assert!(advice.contains("Chromium") && advice.contains("Electron"));
    assert_eq!(
        error.details.expect("details")["kind"],
        "no_accessibility_connection"
    );
}
