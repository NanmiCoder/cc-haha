use std::process::Command;
use std::time::{Duration, Instant};

use agent_desktop_core::ErrorCode;

use super::lift_live_tests::*;
use super::*;
use crate::tree::live::live_launch::Launched;

fn wait_active(pid: u32) -> bool {
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(8) {
        if active_pid() == Some(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

fn names_of_active() -> String {
    let active = xprop(&["-root", "_NET_ACTIVE_WINDOW"]);
    let id = active
        .split_whitespace()
        .last()
        .unwrap_or_default()
        .to_owned();
    xprop(&["-id", &id, "WM_NAME"])
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh"]
fn focus_window_live_a_modal_dialog_is_named_and_the_window_is_not_reported_active() {
    close_overview();
    let bus = SharedBus::default();
    let mut launched = Launched::new();
    let owner = spawn_env(&mut launched, &bus, "owner", false, true);
    std::thread::sleep(Duration::from_secs(2));
    let other = spawn(&mut launched, &bus, "other");
    let _ = focus(&bus, &other);
    let error = focus(&bus, &owner).expect_err("a modal dialog redirects the focus");
    let details = error.details.as_ref().expect("details");
    println!(
        "focus_window_live modal: {details} active={}",
        names_of_active()
    );
    assert_eq!(details["cause"], "blocked_by_modal_dialog");
    assert_eq!(details["dialog"], "adl-dialog");
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    assert!(names_of_active().contains("adl-dialog"));
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh"]
fn focus_window_live_a_stopped_application_is_refused_before_any_request() {
    close_overview();
    let bus = SharedBus::default();
    let mut launched = Launched::new();
    let target = spawn(&mut launched, &bus, "target");
    let _other = spawn(&mut launched, &bus, "other");
    let pid = target.pid.get().to_string();
    assert!(
        Command::new("kill")
            .args(["-STOP", &pid])
            .status()
            .expect("kill runs")
            .success()
    );
    let before = xprop(&["-root", "_NET_ACTIVE_WINDOW"]);
    let started = Instant::now();
    let result = focus(&bus, &target);
    let _ = Command::new("kill").args(["-CONT", &pid]).status();
    let error = result.expect_err("a stopped application is refused");
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert!(
        started.elapsed() < Duration::from_millis(500),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(xprop(&["-root", "_NET_ACTIVE_WINDOW"]), before);
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh"]
fn focus_window_live_a_zenity_dialog_the_toolkit_never_reports_active_is_focused() {
    close_overview();
    let bus = SharedBus::default();
    let mut launched = Launched::new();
    let other = spawn(&mut launched, &bus, "other");
    assert!(wait_active(other.pid.get()));
    let pid = launched.spawn(
        "zenity",
        &["--info", "--title", "adl-zenity", "--text", "hello"],
    );
    let started = Instant::now();
    let dialog = loop {
        if let Some(window) = windows_of(&bus, pid).into_iter().next() {
            break window;
        }
        assert!(started.elapsed() < Duration::from_secs(20), "no dialog");
        std::thread::sleep(Duration::from_millis(200));
    };
    let blocker = spawn(&mut launched, &bus, "blocker");
    assert!(wait_active(blocker.pid.get()));
    focus(&bus, &dialog).expect("the dialog is active on the display with the focus in it");
    assert_eq!(active_pid(), Some(pid), "xprop agrees");
    let xid = xid_of(pid);
    let focused = tool("xdotool")
        .arg("getwindowfocus")
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_owned())
        .unwrap_or_default();
    let focus_xid = u32::from_str_radix(xid.trim_start_matches("0x"), 16).expect("an id");
    assert_eq!(
        focused,
        focus_xid.to_string(),
        "the input focus is in the dialog"
    );
}
