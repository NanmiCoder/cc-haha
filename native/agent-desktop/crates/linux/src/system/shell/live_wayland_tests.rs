use std::process::Command;

use agent_desktop_core::{Deadline, DeliverySemantics, ErrorCode};

use super::anchor::Anchor;
use super::container::{Landmark, locate_anchor};
use super::identity::find_root;
use crate::system::SharedBus;

#[test]
#[ignore = "private native Wayland shell; run through scripts/private-session.sh"]
fn unproven_wayland_popup_openers_refuse_without_pointer_delivery() {
    assert!(std::env::var_os("AGENT_DESKTOP_PRIVATE_SESSION").is_some());
    if std::env::var_os("AD_SHELL_WAYLAND_CHILD").is_none() {
        const FILTER: &str = "system::shell::live_wayland_tests::unproven_wayland_popup_openers_refuse_without_pointer_delivery";
        let output = Command::new("bash")
            .args(["scripts/private-wayland-shell.sh", "--no-input", "--"])
            .arg(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", FILTER, "--nocapture"])
            .env("AD_SHELL_WAYLAND_CHILD", "1")
            .output()
            .unwrap();
        assert!(output.status.success(), "private Wayland child: {output:?}");
        assert!(
            String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"),
            "{FILTER} must execute exactly one test: {output:?}"
        );
        return;
    }
    let bus = SharedBus::default();
    let root = find_root(&bus, Deadline::after(10_000).unwrap()).expect("native shell root");
    super::owner_live_tests::shell_identity_follows_both_bus_owners_and_never_the_process_name();
    locate_anchor(
        &bus,
        &root,
        Anchor::Landmark(Landmark::DateMenu),
        Deadline::after(5_000).unwrap(),
    )
    .expect("the date menu is told by role shape on Wayland too");
    for anchor in [Anchor::SystemButton, Anchor::Landmark(Landmark::SystemMenu)] {
        let error = locate_anchor(&bus, &root, anchor, Deadline::after(5_000).unwrap())
            .expect_err("labels and position cannot identify a popup opener");
        assert_eq!(error.code, ErrorCode::ActionNotSupported);
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    }
    let oracle = Command::new("busctl")
        .args([
            "--user",
            "call",
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
            "GetConnectionUnixProcessID",
            "s",
            "org.gnome.Shell",
        ])
        .output()
        .unwrap();
    assert!(oracle.status.success());
    assert_eq!(
        String::from_utf8(oracle.stdout).unwrap().trim(),
        format!("u {}", root.pid)
    );
    println!(
        "busctl confirms native Wayland shell owner {}; unproven openers refuse without input",
        root.pid
    );
}
