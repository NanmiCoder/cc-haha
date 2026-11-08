use super::*;
use crate::system::close_outcome::CloseOutcome;
use crate::system::process_identity;
use agent_desktop_core::{DeliveryDisposition, ProcessId};

#[test]
fn protected_process_is_refused_before_any_native_close() {
    let app = AppInfo {
        name: "explorer.exe".into(),
        pid: ProcessId::from(1u32),
        bundle_id: None,
        process_instance: Some("windows-proc-v1:1:1".into()),
        presentation: None,
    };
    let error = close_app_impl(&app, true, Deadline::after(1_000).expect("deadline"))
        .expect_err("protected");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert!(error.message.contains("protected"));
    assert!(error.suggestion.is_some());
}

#[test]
fn close_requires_a_creation_time_token() {
    let app = AppInfo {
        name: "notepad.exe".into(),
        pid: ProcessId::from(1u32),
        bundle_id: None,
        process_instance: None,
        presentation: None,
    };
    let error = close_app_impl(&app, false, Deadline::after(1_000).expect("deadline"))
        .expect_err("token required");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
}

#[cfg(target_os = "windows")]
use crate::system::fixture::test_time::deadline;

#[cfg(target_os = "windows")]
fn app_for_pid(name: &str, pid: ProcessId) -> AppInfo {
    let token = process_identity::token_for_pid(pid)
        .expect("token read")
        .expect("live token");
    AppInfo {
        name: name.into(),
        pid,
        bundle_id: None,
        process_instance: Some(token),
        presentation: None,
    }
}

#[cfg(target_os = "windows")]
fn process_still_alive(pid: ProcessId, instance: &str) -> bool {
    !super::process_observed_gone(pid, instance).expect("liveness")
}

#[cfg(target_os = "windows")]
use crate::system::lifecycle_test_support::spawn_windowless_child;

#[cfg(target_os = "windows")]
#[test]
fn graceful_hosted_fixture_ok_only_after_independently_observed_gone() {
    crate::tree::fixture::bootstrap();
    let fixture = crate::tree::fixture::HostedFixture::spawn().expect("fixture");
    let pid = ProcessId::from(fixture.process_id());
    let app = app_for_pid("fixture-host", pid);
    let instance = app.process_instance.clone().expect("token");

    let outcome = close_app_impl(&app, false, deadline(10_000)).expect("graceful close");

    assert_eq!(outcome, CloseOutcome::Exited);

    assert!(
        super::process_observed_gone(pid, &instance).expect("gone check"),
        "Ok(()) requires independent exit observation, not API success alone"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn force_terminates_wm_close_ignoring_process_and_verifies_exit() {
    crate::tree::fixture::bootstrap();
    let fixture = crate::tree::fixture::HostedFixture::spawn_swallowing_wm_close()
        .expect("swallowing fixture");
    let pid = ProcessId::from(fixture.process_id());
    let app = app_for_pid("fixture-host", pid);
    let instance = app.process_instance.clone().expect("token");

    let outcome = close_app_impl(&app, true, deadline(10_000)).expect("force close");

    assert_eq!(outcome, CloseOutcome::Exited);

    assert!(
        super::process_observed_gone(pid, &instance).expect("gone check"),
        "force must TerminateProcess and verify exit against a WM_CLOSE-swallowing host"
    );
}

/// Invert: if `wait_for_exit` returned `Ok(())` before observing process exit,
/// this timeout assertion would fail (go red).
///
/// The target must be a process whose window set this test alone owns.
/// Targeting the test binary's own pid would broadcast `WM_CLOSE` to every
/// top-level window the whole test process owns, including other tests'
/// `LocalFixture` windows running in parallel on that same pid - and those
/// windows fall through to `DefWindowProcW`, which destroys them. A
/// `HostedFixture` child process that swallows `WM_CLOSE` keeps the close
/// request contained to a window nothing else depends on, while still
/// forcing the deadline to genuinely expire.
#[cfg(target_os = "windows")]
#[test]
fn graceful_deadline_timeout_is_delivered_unverified() {
    crate::tree::fixture::bootstrap();
    let fixture = crate::tree::fixture::HostedFixture::spawn_swallowing_wm_close()
        .expect("swallowing fixture");
    let pid = ProcessId::from(fixture.process_id());
    let app = app_for_pid("fixture-host", pid);
    let instance = app.process_instance.clone().expect("token");
    let short = Deadline::after(200).expect("short deadline");

    let error = close_app_impl(&app, false, short).expect_err("timeout");

    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::DeliveredUnverified
    );
    assert!(
        process_still_alive(pid, &instance),
        "timeout must not terminate the target; invert would pass if Ok returned early"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn already_dead_pid_is_benign_ok() {
    let mut child = std::process::Command::new("cmd")
        .args(["/C", "exit", "/B", "0"])
        .spawn()
        .expect("spawn");
    let pid = ProcessId::from(child.id());
    let app = app_for_pid("cmd.exe", pid);
    let _ = child.wait();

    let outcome = close_app_impl(&app, false, deadline(10_000)).expect("already dead is Ok");

    assert_eq!(outcome, CloseOutcome::AlreadyGone);
}

#[cfg(target_os = "windows")]
#[test]
fn race_windows_gone_because_process_died_is_benign_ok() {
    crate::tree::fixture::bootstrap();
    let mut fixture = crate::tree::fixture::HostedFixture::spawn().expect("fixture");
    let pid = ProcessId::from(fixture.process_id());
    let app = app_for_pid("fixture-host", pid);
    fixture.terminate();

    let outcome = close_app_impl(&app, false, deadline(10_000))
        .expect("empty window set after death must follow the handle check, not ACTION_FAILED");

    assert_eq!(outcome, CloseOutcome::AlreadyGone);
}

#[cfg(target_os = "windows")]
#[test]
fn windowless_alive_graceful_is_action_failed_not_delivered_without_terminate() {
    let (_child, pid, token) = spawn_windowless_child();
    let app = AppInfo {
        name: "cmd.exe".into(),
        pid,
        bundle_id: None,
        process_instance: Some(token.clone()),
        presentation: None,
    };
    let windows = super::top_level_windows_for_pid(pid).expect("enumerate");
    assert!(
        windows.is_empty(),
        "CREATE_NO_WINDOW child must present an empty top-level set"
    );

    let error = close_app_impl(&app, false, deadline(10_000)).expect_err("windowless alive");

    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
    assert!(error.message.contains(&pid.to_string()));
    assert!(
        error
            .suggestion
            .as_deref()
            .is_some_and(|text| text.contains("force") && text.contains(&pid.to_string()))
    );
    assert!(
        process_still_alive(pid, &token),
        "graceful windowless must never silent-TerminateProcess"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn mismatched_creation_token_is_benign_ok_without_killing_live_pid() {
    crate::tree::fixture::bootstrap();
    let fixture = crate::tree::fixture::HostedFixture::spawn().expect("fixture");
    let pid = ProcessId::from(fixture.process_id());
    let live = process_identity::token_for_pid(pid)
        .expect("token")
        .expect("live");
    let app = AppInfo {
        name: "fixture-host".into(),
        pid,
        bundle_id: None,
        process_instance: Some("windows-proc-v1:1:1".into()),
        presentation: None,
    };

    let outcome =
        close_app_impl(&app, true, deadline(10_000)).expect("token mismatch is already-gone");

    assert_eq!(outcome, CloseOutcome::AlreadyGone);

    assert!(
        process_still_alive(pid, &live),
        "exit verification must use pid+token; a mismatched token must not TerminateProcess"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn force_terminate_handle_token_must_match_before_kill() {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };

    crate::tree::fixture::bootstrap();
    let fixture = crate::tree::fixture::HostedFixture::spawn().expect("fixture");
    let pid = ProcessId::from(fixture.process_id());
    let live = process_identity::token_for_pid(pid)
        .expect("token")
        .expect("live");
    let access = PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE;
    let handle = unsafe { OpenProcess(access, 0, u32::from(pid)) };
    assert!(!handle.is_null());
    assert!(
        super::handle_matches_instance(handle, pid, &live).expect("read"),
        "live handle must match its creation-time token"
    );
    assert!(
        !super::handle_matches_instance(handle, pid, "windows-proc-v1:1:1").expect("read"),
        "mismatched token on the open handle must refuse terminate"
    );
    unsafe { CloseHandle(handle) };
}

#[cfg(target_os = "windows")]
#[test]
fn graceful_wm_close_skips_hwnd_whose_owner_pid_changed() {
    crate::tree::fixture::bootstrap();
    let fixture = crate::tree::fixture::HostedFixture::spawn().expect("fixture");
    let foreign = crate::tree::fixture::LocalFixture::create().expect("foreign");
    let pid = ProcessId::from(fixture.process_id());
    let token = process_identity::token_for_pid(pid)
        .expect("token")
        .expect("live");
    let delivered = super::post_wm_close_if_still_owned(foreign.handle(), pid, &token)
        .expect("foreign hwnd is skipped, not an error");
    assert!(
        !delivered,
        "a foreign hwnd is reported as not delivered, not as a send"
    );
    assert!(
        process_still_alive(pid, &token),
        "skipping a foreign hwnd must not close the target process"
    );
    let _ = fixture;
}

/// `259` is `STILL_ACTIVE`, the same value `GetExitCodeProcess` reports for a
/// live process, so a process that legitimately exits with it must still be
/// observed gone. The wait signal is what proves the exit; vetoing on the code
/// would leave a cleanly exited process looking alive for as long as a handle
/// keeps it from being reaped - which the child handle held here does.
#[cfg(target_os = "windows")]
#[test]
fn an_exit_code_of_still_active_is_still_observed_as_gone() {
    let mut child = std::process::Command::new("cmd")
        .args(["/C", "exit", "/B", "259"])
        .spawn()
        .expect("spawn");
    let pid = ProcessId::from(child.id());
    let token = process_identity::token_for_pid(pid)
        .expect("token read")
        .expect("live token");
    child.wait().expect("child exits");

    assert!(
        super::process_observed_gone(pid, &token).expect("liveness"),
        "a process that exited with 259 must not read as still running"
    );
}
