use super::*;
use crate::system::bus::bus_fault::BusFault;
use crate::system::bus::bus_stage::Stage;
use crate::system::capture::window::fakes::{FakeGrabber, Rig, deadline};
use crate::system::x11::capture::grab_error::GrabError;
use std::io::ErrorKind;
use std::sync::Arc;
use zbus::Message;

fn method_error(name: &str) -> zbus::Error {
    let call = Message::method_call("/probe", "Probe")
        .and_then(|builder| builder.build(&()))
        .expect("a method call message must build");
    let reply = Message::error(&call.header(), name)
        .and_then(|builder| builder.build(&()))
        .expect("an error reply must build");
    zbus::Error::MethodError(name.try_into().expect("a valid error name"), None, reply)
}

fn io_error(kind: ErrorKind) -> zbus::Error {
    zbus::Error::InputOutput(Arc::new(std::io::Error::from(kind)))
}

fn denied_suggestion(error: zbus::Error, stage: Stage) -> String {
    let fault = BusFault::of(stage, &error).expect("the error must classify as a bus fault");
    let report = report_from_probe(Err(fault.into_error(&error)), CaptureAvailability::Unknown)
        .expect("an unreachable bus must still produce a report");
    assert!(report.accessibility_denied());
    report
        .accessibility_suggestion()
        .expect("a denied state carries its suggestion")
        .to_string()
}

#[test]
fn a_reachable_registry_reports_granted() {
    let report = report_from_probe(Ok(()), CaptureAvailability::Unknown)
        .expect("a granted probe is a report");
    assert!(report.accessibility_granted());
    assert_eq!(report.automation, PermissionState::NotRequired);
    assert_eq!(report.screen_recording, PermissionState::Unknown);
}

#[test]
fn a_missing_accessibility_socket_reports_denied_with_the_restart_step() {
    let suggestion = denied_suggestion(io_error(ErrorKind::NotFound), Stage::AccessibilityBus);
    assert!(suggestion.contains("systemctl --user restart at-spi-dbus-bus.service"));
    assert!(suggestion.contains("log out"));
    assert!(!suggestion.contains("gsettings"));
}

#[test]
fn a_missing_session_bus_reports_denied_with_the_desktop_session_step() {
    let suggestion = denied_suggestion(io_error(ErrorKind::NotFound), Stage::SessionBus);
    assert!(suggestion.contains("session bus"));
    assert!(!suggestion.contains("systemctl"));
}

#[test]
fn an_absent_service_reports_denied_with_the_install_step() {
    for name in [
        "org.freedesktop.DBus.Error.ServiceUnknown",
        "org.freedesktop.DBus.Error.NameHasNoOwner",
    ] {
        let suggestion = denied_suggestion(method_error(name), Stage::SessionBus);
        assert!(suggestion.contains("Install the at-spi2-core package"));
        assert!(suggestion.contains("--talk-name=org.a11y.Bus"));
    }
}

#[test]
fn a_failed_launcher_spawn_reports_denied_with_the_launch_error_step() {
    let suggestion = denied_suggestion(
        method_error("org.freedesktop.DBus.Error.Spawn.ExecFailed"),
        Stage::SessionBus,
    );
    assert!(suggestion.contains("installed but its bus launcher could not start"));
    assert!(suggestion.contains("systemctl --user status at-spi-dbus-bus.service"));
}

#[test]
fn a_bus_timeout_stays_an_error_rather_than_a_denied_report() {
    let timeout = AdapterError::timeout("The accessibility bus did not answer in time");
    let error = report_from_probe(Err(timeout), CaptureAvailability::Unknown)
        .expect_err("a timeout teaches nothing");
    assert_eq!(error.code, ErrorCode::Timeout);
}

#[test]
fn the_bus_error_carries_explicit_non_retryable_evidence() {
    let source = io_error(ErrorKind::NotFound);
    let error = BusFault::SocketGone.into_error(&source);
    assert_eq!(error.code, ErrorCode::PlatformNotSupported);
    assert!(!error.permits_retry_by_default());
}

fn display_down() -> AdapterError {
    AdapterError::new(ErrorCode::PlatformNotSupported, "no display")
}

fn grabber_answering(answer: Result<bool, fn() -> GrabError>) -> FakeGrabber {
    let rig = Rig::standard();
    *rig.grabber.compositing.lock().expect("compositing lock") = answer;
    rig.grabber
}

fn screen_recording_of(
    route: Result<Route, AdapterError>,
    grabber: &FakeGrabber,
) -> PermissionState {
    let capture = capture_availability(route, grabber, deadline());
    report_from_probe(Ok(()), capture)
        .expect("a granted probe is a report")
        .screen_recording
}

#[test]
fn an_x11_display_that_answers_needs_no_screen_recording_permission() {
    let grabber = grabber_answering(Ok(false));
    let state = screen_recording_of(Ok(Route::X11(":0".into())), &grabber);
    assert_eq!(state, PermissionState::NotRequired);
}

#[test]
fn wayland_is_unknown_and_the_display_is_never_asked() {
    let grabber = grabber_answering(Ok(true));
    let state = screen_recording_of(Ok(Route::Wayland), &grabber);
    assert_eq!(state, PermissionState::Unknown);
    assert_eq!(grabber.calls.load(std::sync::atomic::Ordering::SeqCst), 0);
}

#[test]
fn a_display_that_does_not_answer_is_unknown() {
    let grabber = grabber_answering(Err(|| GrabError::Timeout));
    let state = screen_recording_of(Ok(Route::X11(":0".into())), &grabber);
    assert_eq!(state, PermissionState::Unknown);
}

#[test]
fn no_display_variable_is_unknown_and_the_display_is_never_asked() {
    let grabber = grabber_answering(Ok(true));
    let state = screen_recording_of(Err(display_down()), &grabber);
    assert_eq!(state, PermissionState::Unknown);
    assert_eq!(grabber.calls.load(std::sync::atomic::Ordering::SeqCst), 0);
}

#[test]
fn a_failed_capture_probe_never_produces_denied() {
    let failures: [fn() -> GrabError; 4] = [
        || GrabError::Timeout,
        || GrabError::Gone,
        || GrabError::Resource,
        || GrabError::Fault(crate::system::x11::MonitorFault::Denied("refused".into())),
    ];
    for failure in failures {
        let grabber = grabber_answering(Err(failure));
        let state = screen_recording_of(Ok(Route::X11(":0".into())), &grabber);
        assert!(!matches!(state, PermissionState::Denied { .. }));
    }
}

#[test]
fn an_unanswering_display_leaves_the_accessibility_result_as_the_bus_probe_found_it() {
    let grabber = grabber_answering(Err(|| GrabError::Timeout));
    let capture = capture_availability(Ok(Route::X11(":0".into())), &grabber, deadline());
    let unreachable = AdapterError::new(ErrorCode::PlatformNotSupported, "bus gone");
    let report = report_from_probe(Err(unreachable), capture).expect("a denied report");
    assert!(report.accessibility_denied());
    assert_eq!(report.screen_recording, PermissionState::Unknown);
}
