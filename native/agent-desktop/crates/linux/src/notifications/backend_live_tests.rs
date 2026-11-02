use std::process::Command;

use agent_desktop_core::{Deadline, ErrorCode, InteractionPolicy, NotificationFilter};

use crate::system::SharedBus;

#[test]
#[ignore = "requires a private session without a notification service"]
fn a_missing_daemon_keeps_its_detected_backend_refusal() {
    assert!(
        !Command::new("gdbus")
            .args([
                "call",
                "--session",
                "--dest",
                "org.freedesktop.Notifications",
                "--object-path",
                "/org/freedesktop/Notifications",
                "--method",
                "org.freedesktop.Notifications.GetServerInformation",
            ])
            .output()
            .expect("probe daemon")
            .status
            .success()
    );
    let error = super::list(
        &SharedBus::default(),
        &NotificationFilter::default(),
        InteractionPolicy::headless(),
        Deadline::after(30_000).unwrap(),
        None,
    )
    .expect_err("missing daemon");
    assert_eq!(error.code, ErrorCode::PlatformNotSupported);
    assert_eq!(error.details.as_ref().unwrap()["daemon"], "absent");
}
