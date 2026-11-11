use agent_desktop_core::ErrorCode;

use super::{decide, decide_x11, fault_error};
use crate::system::display::display_cause::Cause;
use crate::system::display::display_mutter::LogicalMonitor;
use crate::system::display::display_server::DisplayServer;
use crate::system::display::display_unavailable::Unavailable;
use crate::system::x11::{MonitorFault, X11Monitor};
use crate::tree::Extents;

fn monitor(name: &str, connectors: &[&str], x: i32, w: i32, primary: bool) -> X11Monitor {
    X11Monitor {
        name: name.to_owned(),
        connectors: connectors.iter().map(|c| c.to_string()).collect(),
        bounds: Extents {
            x,
            y: 0,
            width: w,
            height: 800,
        },
        primary,
    }
}

fn logical(connectors: &[&str], scale: f64, primary: bool) -> LogicalMonitor {
    LogicalMonitor {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
        scale,
        primary,
        connectors: connectors.iter().map(|c| c.to_string()).collect(),
    }
}

fn x11() -> DisplayServer {
    DisplayServer::X11(":0".to_owned())
}

#[test]
fn the_measured_virtual_monitor_reports_name_bounds_primary_and_one_scale() {
    let displays = decide(
        x11(),
        Some(vec![monitor("Virtual1", &["Virtual1"], 0, 1280, true)]),
        None,
    )
    .expect("monitors read");
    let [display] = displays.as_slice() else {
        panic!("one display")
    };
    assert_eq!(display.id, "Virtual1");
    assert_eq!(
        (
            display.bounds.x,
            display.bounds.width,
            display.bounds.height
        ),
        (0.0, 1280.0, 800.0)
    );
    assert!(display.is_primary);
    assert_eq!(display.scale, 1.0);
}

#[test]
fn mutter_scale_matches_on_a_shared_connector_and_missing_monitors_keep_one() {
    let monitors = vec![
        monitor("DP-1", &["DP-1"], 0, 1920, true),
        monitor("HDMI-1", &["HDMI-1"], 1920, 1920, false),
    ];
    let mutter = vec![logical(&["DP-1"], 2.0, true)];
    let displays = decide(x11(), Some(monitors), Some(mutter)).expect("read");
    assert_eq!(displays[0].scale, 2.0);
    assert_eq!(displays[1].scale, 1.0);
}

#[test]
fn mutter_scale_also_matches_a_randr_monitor_named_for_its_output() {
    let monitors = vec![monitor("auto", &["eDP-1"], 0, 1920, true)];
    let mutter = vec![logical(&["eDP-1"], 1.5, true)];
    let displays = decide(x11(), Some(monitors), Some(mutter)).expect("read");
    assert_eq!(displays[0].scale, 1.5);
}

#[test]
fn the_primary_monitor_sorts_first_even_when_listed_last() {
    let monitors = vec![
        monitor("HDMI-1", &["HDMI-1"], 1920, 1920, false),
        monitor("DP-1", &["DP-1"], 0, 1920, true),
    ];
    let displays = decide(x11(), Some(monitors), None).expect("read");
    assert!(displays[0].is_primary);
    assert_eq!(displays[0].id, "DP-1");
}

#[test]
fn a_server_that_flags_no_primary_makes_its_first_monitor_primary() {
    let monitors = vec![
        monitor("screen", &["screen"], 0, 1280, false),
        monitor("HDMI-1", &["HDMI-1"], 1280, 1920, false),
    ];
    let displays = decide(x11(), Some(monitors), None).expect("read");
    assert_eq!(displays.iter().filter(|d| d.is_primary).count(), 1);
    assert_eq!(displays[0].id, "screen");
    assert!(displays[0].is_primary);
}

#[test]
fn an_x11_read_failure_is_an_error_not_an_empty_list() {
    let error = decide(x11(), None, None).expect_err("unreadable");
    assert_eq!(error.code, ErrorCode::Internal);
}

#[test]
fn a_wayland_session_without_mutter_is_platform_not_supported() {
    let error = decide(DisplayServer::Wayland, Some(vec![]), None).expect_err("no mutter");
    assert_eq!(error.code, ErrorCode::PlatformNotSupported);
}

#[test]
fn a_wayland_session_uses_the_mutter_list_alone() {
    let mutter = vec![logical(&["XWAYLAND0"], 1.0, true)];
    let displays = decide(
        DisplayServer::Wayland,
        Some(vec![monitor("ignored", &[], 0, 1, true)]),
        Some(mutter),
    )
    .expect("mutter answers");
    let [display] = displays.as_slice() else {
        panic!("one display")
    };
    assert_eq!(display.id, "XWAYLAND0");
    assert_eq!(display.bounds.width, 1920.0);
}

fn unavailable(cause: Cause, detail: &str) -> DisplayServer {
    DisplayServer::Unavailable(Unavailable {
        cause,
        detail: detail.to_owned(),
    })
}

#[test]
fn a_session_without_a_display_server_is_platform_not_supported() {
    let error = decide(unavailable(Cause::NotConfigured, ""), None, None).expect_err("headless");
    assert_eq!(error.code, ErrorCode::PlatformNotSupported);
}

#[test]
fn a_missing_display_and_a_refused_one_say_why() {
    let missing = decide(
        unavailable(
            Cause::Missing,
            "DISPLAY=:9 names a server that is not running",
        ),
        None,
        None,
    )
    .expect_err("missing");
    let refused = decide(
        unavailable(Cause::Refused, "DISPLAY=:9 refused the connection"),
        None,
        None,
    )
    .expect_err("refused");
    assert!(missing.message.contains("not running"));
    assert!(refused.message.contains("refused"));
    let cause = |error: &agent_desktop_core::AdapterError| {
        error
            .details
            .as_ref()
            .and_then(|details| details.get("display_unavailable"))
            .and_then(|value| value.as_str())
            .map(str::to_owned)
    };
    assert_eq!(cause(&missing).as_deref(), Some("missing"));
    assert_eq!(cause(&refused).as_deref(), Some("refused"));
}

#[test]
fn a_mutter_that_timed_out_still_reports_the_randr_monitors_at_scale_one() {
    let monitors = vec![monitor("DP-1", &["DP-1"], 0, 1920, true)];
    let displays = decide_x11(
        x11(),
        Ok(monitors),
        Err(agent_desktop_core::AdapterError::timeout("mutter")),
    )
    .expect("randr answered");
    assert_eq!(displays.len(), 1);
    assert_eq!(displays[0].scale, 1.0);
}

#[test]
fn a_mutter_that_answers_still_supplies_the_scale_on_x11() {
    let monitors = vec![monitor("DP-1", &["DP-1"], 0, 1920, true)];
    let displays = decide_x11(
        x11(),
        Ok(monitors),
        Ok(Some(vec![logical(&["DP-1"], 2.0, true)])),
    )
    .expect("read");
    assert_eq!(displays[0].scale, 2.0);
}

#[test]
fn an_unreadable_randr_stays_an_error_whatever_mutter_says() {
    let error = decide_x11(
        x11(),
        Err(fault_error(":0", Some(MonitorFault::Unreadable))),
        Ok(Some(vec![logical(&["DP-1"], 2.0, true)])),
    )
    .expect_err("unreadable");
    assert_eq!(error.code, ErrorCode::Internal);
}

fn cause(error: &agent_desktop_core::AdapterError) -> Option<String> {
    error
        .details
        .as_ref()
        .and_then(|details| details.get("display_unavailable"))
        .and_then(|value| value.as_str())
        .map(str::to_owned)
}

#[test]
fn a_display_that_refuses_this_client_is_a_permanent_refusal_and_not_a_retry() {
    let error = fault_error(
        ":1",
        Some(MonitorFault::Denied("Authorization required".to_owned())),
    );
    assert_eq!(error.code, ErrorCode::PlatformNotSupported);
    assert_eq!(cause(&error).as_deref(), Some("auth_refused"));
    assert!(error.message.contains("Authorization required"));
    assert!(!error.is_explicitly_retryable());
    assert!(
        !error
            .suggestion
            .as_deref()
            .is_some_and(|text| text.contains("Retry once"))
    );
}

#[test]
fn a_display_nothing_answers_at_names_the_address_and_a_silent_one_is_a_timeout() {
    let missing = fault_error(
        "remote:0",
        Some(MonitorFault::Unreachable("connection refused".to_owned())),
    );
    assert_eq!(missing.code, ErrorCode::PlatformNotSupported);
    assert_eq!(cause(&missing).as_deref(), Some("refused"));
    assert!(missing.message.contains("remote:0"));
    let silent = fault_error("remote:0", None);
    assert_eq!(silent.code, ErrorCode::Timeout);
}

#[test]
fn display_causes_have_one_code_and_permanent_causes_are_not_retried() {
    use crate::system::display::display_error::{DisplayCause, display_cause_error};
    for (cause, label, code) in [
        (
            DisplayCause::NotConfigured,
            "not_configured",
            ErrorCode::PlatformNotSupported,
        ),
        (
            DisplayCause::Missing {
                address: "missing".into(),
            },
            "missing",
            ErrorCode::PlatformNotSupported,
        ),
        (
            DisplayCause::Refused {
                detail: "refused".into(),
            },
            "refused",
            ErrorCode::PlatformNotSupported,
        ),
        (
            DisplayCause::AuthRefused {
                reason: "auth".into(),
            },
            "auth_refused",
            ErrorCode::PlatformNotSupported,
        ),
        (DisplayCause::Silent, "silent", ErrorCode::Timeout),
    ] {
        let error = display_cause_error(&cause);
        assert_eq!(error.code, code);
        assert_eq!(
            error.details.as_ref().expect("cause")["display_unavailable"],
            label
        );
        assert_eq!(error.permits_retry_by_default(), code == ErrorCode::Timeout);
    }
}
