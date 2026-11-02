use crate::system::shell::fake_tree::{SENTINEL, at};
use crate::tree::AtspiElement;
use crate::tree::placement::visibility::is_placed;
use crate::tree::properties::absence::UNKNOWN_OBJECT;
use agent_desktop_core::{AdapterError, ErrorCode};

#[test]
fn extents_name_a_place_only_with_area_and_no_sentinel() {
    assert!(is_placed(at(0, 0, 72, 32)));
    assert!(is_placed(at(-10, -1, 60, 84)));
    assert!(!is_placed(at(0, 0, 0, 32)));
    assert!(!is_placed(at(0, 0, 10, 0)));
    assert!(!is_placed(SENTINEL));
}

#[test]
fn a_node_that_died_between_listing_and_reading_is_missing_and_not_broken() {
    let dead = AdapterError::new(
        ErrorCode::Internal,
        "The children of the accessible object could not be listed",
    )
    .with_platform_detail(format!("{UNKNOWN_OBJECT}: the object does not exist"));
    assert_eq!(
        super::missing_when_dead(dead).code,
        ErrorCode::ElementNotFound
    );
    let slow = AdapterError::new(ErrorCode::Internal, "The children could not be listed")
        .with_platform_detail("org.freedesktop.DBus.Error.NoReply: no answer");
    assert_eq!(super::missing_when_dead(slow).code, ErrorCode::Internal);
}

#[test]
#[ignore = "owns a private bus; run inside scripts/private-session.sh --wm"]
fn shell_live_lost_role_connection_is_not_a_destroyed_node() {
    use std::io::{BufRead, BufReader};
    use std::process::{Child, Command, Stdio};

    use agent_desktop_core::{Deadline, DeliverySemantics, ErrorCode};

    struct Daemon(Child);
    impl Drop for Daemon {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    let runtime = std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").expect("private session");
    let mut daemon = Daemon(
        Command::new("dbus-daemon")
            .args([
                "--session",
                "--nofork",
                "--print-address=1",
                &format!("--address=unix:path={runtime}/role-loss-bus"),
            ])
            .stdout(Stdio::piped())
            .spawn()
            .expect("owned bus"),
    );
    let mut address = String::new();
    BufReader::new(daemon.0.stdout.take().expect("address pipe"))
        .read_line(&mut address)
        .expect("bus readiness");
    let connection = zbus::block_on(async {
        zbus::connection::Builder::address(address.trim())
            .expect("address")
            .build()
            .await
            .expect("connection")
    });
    let element = AtspiElement::new("org.freedesktop.DBus", "/absent", 0);
    let read = || {
        crate::system::within(
            Deadline::after(2_000).expect("deadline"),
            super::role_of(&connection, &element),
        )
    };
    assert!(
        read()
            .expect("a real missing object stays absent")
            .is_none()
    );
    daemon.0.kill().expect("kill owned bus");
    assert!(!daemon.0.wait().expect("process exit oracle").success());
    let error = read().expect_err("lost role transport cannot mean a destroyed node");
    assert_eq!(error.code, ErrorCode::Internal);
    assert_eq!(error.disposition, DeliverySemantics::unknown());
    println!("owned daemon exited: required shell role = {error:?}");
}
