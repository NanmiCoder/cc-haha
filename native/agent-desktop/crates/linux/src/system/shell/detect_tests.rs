use agent_desktop_core::ErrorCode;

use super::requirements::check_owners;
use super::{Fact, classify_daemon, classify_tree, daemon_fact_error};
use crate::system::shell::call_failure::CallFailure;

#[test]
fn daemon_requirement_uses_protocol_presence_instead_of_server_branding() {
    for name in ["gnome-shell", "kded"] {
        let (daemon, server) = classify_daemon(Ok(name.to_owned()));
        daemon_fact_error(&daemon, server.as_deref()).expect("protocol presence ignores branding");
    }
    let (daemon, server) = classify_daemon(Err(CallFailure::NoService));
    let absent = daemon_fact_error(&daemon, server.as_deref()).expect_err("service absent");
    assert_eq!(absent.code, ErrorCode::PlatformNotSupported);
    assert_eq!(absent.details.unwrap()["daemon"], "absent");

    let (daemon, server) = classify_daemon(Err(CallFailure::Transport("bus stalled".into())));
    let unreadable = daemon_fact_error(&daemon, server.as_deref()).expect_err("failed read");
    assert_eq!(unreadable.code, ErrorCode::Timeout);
    assert_eq!(unreadable.details.unwrap()["retryable"], true);
}

#[test]
fn tree_detection_preserves_registry_failure_classes() {
    for (owner, registry) in [
        (Err(CallFailure::NoService), None),
        (Ok(7), Some(Ok(false))),
        (Ok(7), Some(Err(CallFailure::NoService))),
    ] {
        assert!(matches!(classify_tree(owner, registry), Fact::Absent(_)));
    }
    for (owner, registry) in [
        (Err(CallFailure::Transport("bus stalled".into())), None),
        (
            Ok(7),
            Some(Err(CallFailure::Transport("registry stalled".into()))),
        ),
    ] {
        assert!(matches!(
            classify_tree(owner, registry),
            Fact::Unreadable(_)
        ));
    }
    assert_eq!(classify_tree(Ok(7), Some(Ok(true))), Fact::Present);
}

#[test]
fn a_helper_that_proves_to_be_the_shells_service_may_own_the_notification_name() {
    check_owners(Ok(20), Ok(10), Some("gnome-shell"), |owner, shell| {
        (owner, shell) == (20, 10)
    })
    .expect("the shell's own service is admitted");
    check_owners(Ok(10), Ok(10), Some("gnome-shell"), |_, _| false)
        .expect("one process owning both names needs no further proof");

    let unknown = check_owners(Ok(20), Ok(10), Some("kded"), |_, _| false)
        .expect_err("an unproven owner is refused");
    assert_eq!(unknown.code, ErrorCode::PlatformNotSupported);
    assert_eq!(unknown.details.unwrap()["daemon"], "unsupported");
}
