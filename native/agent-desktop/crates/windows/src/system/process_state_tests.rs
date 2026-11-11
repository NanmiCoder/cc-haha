use super::*;
use agent_desktop_core::{
    Deadline, ErrorCode, ProcessId, ProcessIdentity, system::process_state::ProcessState,
};
use std::cell::Cell;
use std::time::{Duration, Instant};

const STILL_ACTIVE: u32 = 259;

#[test]
fn single_transient_hung_probe_stays_running() {
    let calls = Cell::new(0);
    let state = classify_hang(|| {
        let n = calls.get() + 1;
        calls.set(n);
        if n == 1 {
            Ok(HangProbeResult::Hung)
        } else {
            Ok(HangProbeResult::Responsive)
        }
    })
    .unwrap();
    assert_eq!(state, ProcessState::Running);
    assert_eq!(calls.get(), 2);
}

#[test]
fn two_consecutive_hung_probes_classify_unresponsive() {
    let calls = Cell::new(0);
    let state = classify_hang(|| {
        calls.set(calls.get() + 1);
        Ok(HangProbeResult::Hung)
    })
    .unwrap();
    assert_eq!(state, ProcessState::Unresponsive);
    assert_eq!(calls.get(), 2);
}

#[test]
fn immediately_responsive_probe_classifies_running() {
    let calls = Cell::new(0);
    let state = classify_hang(|| {
        calls.set(calls.get() + 1);
        Ok(HangProbeResult::Responsive)
    })
    .unwrap();
    assert_eq!(state, ProcessState::Running);
    assert_eq!(calls.get(), 1);
}

#[test]
fn clean_exit_code_is_exited() {
    assert_eq!(
        state_from_exit_code(0),
        ProcessState::Exited { code: Some(0) }
    );
}

#[test]
fn crash_shaped_exit_code_is_crashed() {
    assert_eq!(
        state_from_exit_code(0xC000_0005),
        ProcessState::Crashed {
            signal_or_code: 0xC000_0005_u32 as i32
        }
    );
}

#[test]
fn still_active_code_without_wait_gate_would_look_exited() {
    assert_eq!(
        state_from_exit_code(STILL_ACTIVE),
        ProcessState::Exited {
            code: Some(STILL_ACTIVE as i32)
        },
        "without WaitForSingleObject, GetExitCodeProcess=259 would misread as Exited; the live path gates on WAIT_OBJECT_0 first (A21-3)"
    );
}

#[test]
fn hresult_from_win32_matches_facility_win32_shape() {
    assert_eq!(
        crate::system::runtime::hresult::hresult_from_win32(5),
        0x8007_0005_u32 as i32
    );
    assert_eq!(crate::system::runtime::hresult::hresult_from_win32(0), 0);
}

#[cfg(target_os = "windows")]
fn identity_for_pid(pid: ProcessId) -> ProcessIdentity {
    crate::system::fixture::live_identity::live_process_identity(pid)
}

#[cfg(target_os = "windows")]
use crate::system::fixture::test_time::deadline;

#[cfg(target_os = "windows")]
#[test]
fn wait_failure_is_reported_never_treated_as_alive() {
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    let pid = ProcessId::from(std::process::id());
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, u32::from(pid)) };
    assert!(
        !handle.is_null(),
        "OpenProcess with only PROCESS_QUERY_LIMITED_INFORMATION must still succeed"
    );
    let outcome = classify_opened(handle, pid, deadline(5_000));
    close_handle(handle);
    let error = outcome.expect_err(
        "a handle without SYNCHRONIZE rights cannot wait, so liveness must not be reported",
    );
    assert_eq!(
        error.code,
        ErrorCode::PermDenied,
        "WAIT_FAILED must surface the classified Win32 error, not an invented Running state"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn live_scratch_process_classifies_running() {
    crate::tree::fixture::bootstrap();
    let fixture = crate::tree::fixture::HostedFixture::spawn().expect("hosted fixture");
    let pid = ProcessId::from(fixture.process_id());
    let state = process_state_impl(identity_for_pid(pid), deadline(5_000)).expect("classify");
    assert_eq!(state, ProcessState::Running);
}

#[cfg(target_os = "windows")]
#[test]
fn clean_exit_classifies_exited_zero() {
    let mut child = std::process::Command::new("cmd")
        .args(["/C", "exit", "/B", "0"])
        .spawn()
        .expect("spawn cmd");
    let pid = ProcessId::from(child.id());
    let identity = identity_for_pid(pid);
    let status = child.wait().expect("wait");
    assert!(status.success());
    let state = process_state_impl(identity, deadline(5_000)).expect("classify");
    assert_eq!(state, ProcessState::Exited { code: Some(0) });
}

#[cfg(target_os = "windows")]
#[test]
fn crash_shaped_terminate_classifies_crashed() {
    let mut child = std::process::Command::new("cmd")
        .args(["/C", "ping", "-n", "60", "127.0.0.1", ">", "NUL"])
        .spawn()
        .expect("spawn scratch");
    let pid = ProcessId::from(child.id());
    let identity = identity_for_pid(pid);
    terminate_with_code(u32::from(pid), 0xC000_0005);
    let _ = child.wait();
    let state = process_state_impl(identity, deadline(5_000)).expect("classify");
    assert_eq!(
        state,
        ProcessState::Crashed {
            signal_or_code: 0xC000_0005_u32 as i32
        }
    );
}

#[cfg(target_os = "windows")]
#[test]
fn running_process_is_never_exited_despite_still_active_code() {
    let pid = ProcessId::from(std::process::id());
    let state = process_state_impl(identity_for_pid(pid), deadline(5_000)).expect("classify");
    assert!(
        !matches!(state, ProcessState::Exited { .. }),
        "wait-gate must keep a live process as non-Exited; got {state:?}"
    );
    assert!(
        matches!(state, ProcessState::Running | ProcessState::Unresponsive),
        "live self process is Running or Unresponsive, never Exited; got {state:?}"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn stalled_fixture_classifies_unresponsive() {
    let stalled = crate::tree::fixture::StalledFixture::create().expect("stalled");
    wait_until_hung(stalled.handle());
    let pid = ProcessId::from(std::process::id());
    let state = process_state_impl(identity_for_pid(pid), deadline(5_000)).expect("classify");
    assert_eq!(
        state,
        ProcessState::Unresponsive,
        "any hung top-level window of the pid must classify Unresponsive (handle={})",
        stalled.handle()
    );
}

#[cfg(target_os = "windows")]
#[test]
fn multi_window_any_one_hung_classifies_unresponsive() {
    crate::tree::fixture::bootstrap();
    let pumping = crate::tree::fixture::LocalFixture::create().expect("pumping");
    let stalled = crate::tree::fixture::StalledFixture::create().expect("stalled");
    wait_until_hung(stalled.handle());
    let pid = ProcessId::from(std::process::id());
    let state = process_state_impl(identity_for_pid(pid), deadline(5_000)).expect("classify");
    assert_eq!(
        state,
        ProcessState::Unresponsive,
        "pumping={} stalled={} — any-one-hangs",
        pumping.handle(),
        stalled.handle()
    );
}

#[cfg(target_os = "windows")]
#[test]
fn windowless_process_never_classifies_unresponsive() {
    let mut child = std::process::Command::new("cmd")
        .args(["/C", "ping", "-n", "30", "127.0.0.1", ">", "NUL"])
        .spawn()
        .expect("spawn windowless");
    let pid = ProcessId::from(child.id());
    let identity = identity_for_pid(pid);
    let state = process_state_impl(identity, deadline(5_000)).expect("classify");
    let _ = child.kill();
    let _ = child.wait();
    assert_eq!(
        state,
        ProcessState::Running,
        "no top-level window means handle-only liveness, never Unresponsive"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn token_mismatch_reports_exited_for_original_generation() {
    let pid = ProcessId::from(std::process::id());
    let mut identity = identity_for_pid(pid);
    identity.instance = "windows-proc-v1:1:2".into();
    let state = process_state_impl(identity, deadline(5_000)).expect("classify");
    assert_eq!(state, ProcessState::Exited { code: None });
}

#[cfg(target_os = "windows")]
#[test]
fn classifier_is_deadline_bounded_against_hung_target() {
    let stalled = crate::tree::fixture::StalledFixture::create().expect("stalled");
    wait_until_hung(stalled.handle());
    let pid = ProcessId::from(std::process::id());
    let identity = identity_for_pid(pid);
    let started = Instant::now();
    let outcome = process_state_impl(identity, Deadline::after(200).expect("short deadline"));
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_secs(2),
        "hung probe must stay deadline-bounded; elapsed={elapsed:?} handle={}",
        stalled.handle()
    );
    match outcome {
        Ok(ProcessState::Unresponsive) | Err(_) => {}
        Ok(other) => panic!("expected Unresponsive or TIMEOUT, got {other:?}"),
    }
}

#[cfg(target_os = "windows")]
fn wait_until_hung(hwnd: isize) {
    use windows_sys::Win32::UI::WindowsAndMessaging::IsHungAppWindow;

    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(15) {
        if unsafe { IsHungAppWindow(hwnd as *mut core::ffi::c_void) } != 0 {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    panic!("IsHungAppWindow never marked hwnd={hwnd} hung within 15s (A21-4 ~5s heuristic)");
}

#[cfg(target_os = "windows")]
fn terminate_with_code(pid: u32, code: u32) {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
        TerminateProcess, WaitForSingleObject,
    };

    let access = PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE;
    let handle = unsafe { OpenProcess(access, 0, pid) };
    assert!(!handle.is_null(), "OpenProcess for terminate");
    let ok = unsafe { TerminateProcess(handle, code) };
    assert!(ok != 0, "TerminateProcess");
    let waited = unsafe { WaitForSingleObject(handle, 5_000) };
    assert_eq!(waited, WAIT_OBJECT_0, "process must exit");
    unsafe {
        CloseHandle(handle);
    }
}
