use super::*;
use agent_desktop_core::{
    AppError, Deadline, DeliverySemantics, ErrorCode, ErrorPayload, ProcessId,
};

#[cfg(target_os = "windows")]
use super::super::launch_path::resolve_executable;
#[cfg(target_os = "windows")]
use std::path::{Path, PathBuf};

#[cfg(target_os = "windows")]
#[path = "launch_live_tests.rs"]
mod live;

#[test]
fn zero_wait_never_polls_after_first_observation() {
    assert!(!should_poll_after_first_observation(0));
    assert!(should_poll_after_first_observation(1));
}

#[test]
fn ambiguous_launch_target_suggestion_names_pids_instead_of_a_ref_retry() {
    let matches = vec![
        ProcessRow {
            pid: ProcessId::from(111),
            name: "Cursor.exe".into(),
        },
        ProcessRow {
            pid: ProcessId::from(222),
            name: "Cursor.exe".into(),
        },
    ];

    let error = ambiguous_apps(&matches);

    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
    let suggestion = error
        .suggestion
        .as_deref()
        .expect("ambiguous launch target has a suggestion");
    assert!(
        !suggestion.contains("ref"),
        "launch has no ref to disambiguate with: {suggestion}"
    );
    assert!(
        suggestion.contains("111") && suggestion.contains("222"),
        "suggestion must name the candidate pids the caller cannot select among: {suggestion}"
    );
}

/// The envelope a caller reads when a launch name matches several running
/// instances: the refusal happens before any process is started, and the
/// candidate pids travel in `details` so the caller can pick one by pid.
#[test]
fn shared_ambiguous_target_pins_the_windows_envelope() {
    let matches = vec![
        ProcessRow {
            pid: ProcessId::from(10),
            name: "Cursor.exe".into(),
        },
        ProcessRow {
            pid: ProcessId::from(11),
            name: "Cursor.exe".into(),
        },
    ];

    let wire = serde_json::to_value(ErrorPayload::from_app_error(&AppError::from(
        ambiguous_apps(&matches),
    )))
    .expect("ErrorPayload serializes");

    assert_eq!(wire["code"], ErrorCode::AmbiguousTarget.as_str());
    assert_eq!(
        wire["disposition"],
        serde_json::to_value(DeliverySemantics::not_delivered()).expect("disposition serializes")
    );
    assert_eq!(
        wire["details"]["candidate_pids"],
        serde_json::json!([10, 11])
    );
}

/// The `Timeout` arm of [`is_unobservable_within_budget`], mirroring the
/// `WindowNotFound` arm's tolerance: an already-expired deadline makes
/// `list_windows_live`'s shared retry budget (`retry_transient_window_race`'s
/// own `ensure_remaining` preamble) refuse before any native enumeration runs,
/// so `exact_window` returns `Err(Timeout)` deterministically and needs no
/// fixture. A launch racing its own deadline must still resolve to "no
/// window observed" here - the deadline itself is what ends `observe_window`'s
/// polling loop one level up, not this one read.
#[test]
fn observe_window_once_tolerates_an_expired_deadline_as_no_window_observed() {
    let pid = ProcessId::from(std::process::id());
    let expired = Deadline::after(0).expect("a zero-timeout deadline is constructible");

    let observed = observe_window_once(pid, "irrelevant-instance", expired)
        .expect("a Timeout from the inventory must be tolerated, not propagated");

    assert!(
        observed.is_none(),
        "an expired deadline must report no window observed rather than an error"
    );
}

#[test]
fn launch_options_enforce_bounded_entry_counts() {
    let options = LaunchOptions {
        args: (0..=256).map(|index| index.to_string()).collect(),
        ..Default::default()
    };
    let error = validate_launch_options(&options).expect_err("too many args");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
}

#[test]
fn launch_options_enforce_a_bounded_text_budget() {
    let options = LaunchOptions {
        args: vec!["x".repeat(1024 * 1024 + 1)],
        ..Default::default()
    };
    let error = validate_launch_options(&options).expect_err("payload too large");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
}

#[test]
fn elevation_required_maps_through_hresult_from_win32() {
    let hresult = crate::system::runtime::hresult::hresult_from_win32(740);
    assert_eq!(hresult, 0x8007_02E4_u32 as i32);
    let error = crate::system::runtime::hresult::adapter_error_from_win32(
        740,
        "CreateProcessW failed to start the application",
    );
    assert!(
        error
            .platform_detail
            .as_deref()
            .is_some_and(|detail| detail.to_ascii_uppercase().contains("800702E4")),
        "platform_detail should carry HRESULT_FROM_WIN32(740): {:?}",
        error.platform_detail
    );
}

#[test]
fn environment_merge_folds_case_so_override_replaces_inherited_variable() {
    let key = format!("AGENT_DESKTOP_LAUNCH_TEST_{}", std::process::id());
    unsafe { std::env::set_var(&key, "inherited") };
    let mut overrides = BTreeMap::new();
    overrides.insert(key.to_ascii_lowercase(), "overridden".to_string());
    let block = environment_block(&overrides).expect("environment block");
    unsafe { std::env::remove_var(&key) };
    let text = String::from_utf16_lossy(&block);
    let folded_prefix = format!("{}=", key.to_ascii_uppercase());
    let matching_entries: Vec<String> = text
        .split('\0')
        .filter(|entry| entry.to_ascii_uppercase().starts_with(&folded_prefix))
        .map(str::to_string)
        .collect();
    assert_eq!(
        matching_entries,
        vec![format!("{}=overridden", key.to_ascii_lowercase())],
        "the caller's override must be the only surviving entry for this name, in its own spelling"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn absolute_cwd_refuses_a_relative_working_directory() {
    let error = super::absolute_cwd(Path::new(r"relative\dir"))
        .expect_err("a relative cwd must be refused before CreateProcessW");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
}

#[cfg(target_os = "windows")]
#[test]
fn absolute_cwd_returns_an_absolute_path_unchanged() {
    let absolute = Path::new(r"C:\agent-desktop-launch-cwd-probe");
    let returned =
        super::absolute_cwd(absolute).expect("an absolute cwd must be accepted unchanged");
    assert_eq!(returned, absolute);
}

#[cfg(target_os = "windows")]
use crate::system::fixture::test_time::deadline;

#[cfg(target_os = "windows")]
fn matching_pids(image: &str) -> Vec<ProcessId> {
    matching_processes(image)
        .expect("snapshot")
        .into_iter()
        .map(|row| row.pid)
        .collect()
}

#[cfg(target_os = "windows")]
fn terminate_pid(pid: ProcessId) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_TERMINATE, TerminateProcess};
    let handle = unsafe { OpenProcess(PROCESS_TERMINATE, 0, u32::from(pid)) };
    if !handle.is_null() {
        unsafe {
            TerminateProcess(handle, 1);
            CloseHandle(handle);
        }
    }
}

#[cfg(target_os = "windows")]
struct KillOnDrop(ProcessId);

#[cfg(target_os = "windows")]
impl Drop for KillOnDrop {
    fn drop(&mut self) {
        terminate_pid(self.0);
    }
}

#[cfg(target_os = "windows")]
fn scratch_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "agent-desktop-launch-{label}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("scratch dir");
    dir
}

/// Copies this test binary under a unique name to serve as a launch probe.
///
/// A copied system application is not a dependable probe: `notepad.exe`
/// re-execs and exits the moment it is started from outside its install
/// location, so the copy is gone before the process table is read, and which
/// system applications survive copying differs per Windows image. The test
/// binary always exists, always survives being copied, and already knows how
/// to host a real window - so the probe is repo-controlled rather than a bet
/// on what is installed.
#[cfg(target_os = "windows")]
fn copy_probe_binary(dest_dir: &Path, alias: &str) -> PathBuf {
    let source = std::env::current_exe().expect("test binary path");
    let dest = dest_dir.join(alias);
    std::fs::copy(&source, &dest).expect("copy test binary");
    dest
}

/// The arguments and environment that turn a copy of the test binary into the
/// windowed fixture host, matching what `HostedFixture` spawns.
#[cfg(target_os = "windows")]
fn fixture_host_args() -> Vec<String> {
    [
        "--exact",
        "tree::fixture::tests::fixture_host_process_entry",
        "--ignored",
        "--nocapture",
    ]
    .iter()
    .map(|value| (*value).to_string())
    .collect()
}

#[cfg(target_os = "windows")]
fn fixture_host_env() -> std::collections::BTreeMap<String, String> {
    std::collections::BTreeMap::from([(
        String::from("AGENT_DESKTOP_FIXTURE_HOST"),
        String::from("1"),
    )])
}

/// `LaunchOptions` that start the windowed fixture host, with the launch
/// policy the calling test is actually exercising.
#[cfg(target_os = "windows")]
fn probe_launch_options(attach_if_running: bool, timeout_ms: u64) -> LaunchOptions {
    LaunchOptions {
        args: fixture_host_args(),
        env: fixture_host_env(),
        attach_if_running,
        timeout_ms,
        ..Default::default()
    }
}

#[cfg(target_os = "windows")]
fn copy_system_exe(name: &str, dest_dir: &Path, alias: &str) -> PathBuf {
    let source = resolve_executable(name).expect("system executable");
    let dest = dest_dir.join(alias);
    std::fs::copy(&source, &dest).expect("copy executable");
    dest
}

#[cfg(target_os = "windows")]
fn start_windowed_probe(exe: &Path) -> KillOnDrop {
    let child = std::process::Command::new(exe)
        .args(fixture_host_args())
        .env("AGENT_DESKTOP_FIXTURE_HOST", "1")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("start windowed probe");
    let pid = ProcessId::from(child.id());
    std::mem::forget(child);
    let started = std::time::Instant::now();
    while started.elapsed() < std::time::Duration::from_secs(5) {
        let token = match process_identity::token_for_pid(pid) {
            Ok(Some(token)) => token,
            _ => {
                std::thread::sleep(std::time::Duration::from_millis(50));
                continue;
            }
        };
        if exact_window(pid, &token, Deadline::after(200).expect("short"))
            .ok()
            .flatten()
            .is_some()
        {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    KillOnDrop(pid)
}

#[cfg(target_os = "windows")]
fn start_named_windowless(exe: &Path, args: &[&str]) -> KillOnDrop {
    let child = std::process::Command::new(exe)
        .args(args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("start windowless");
    let pid = ProcessId::from(child.id());
    std::mem::forget(child);
    KillOnDrop(pid)
}

#[cfg(target_os = "windows")]
fn full_image_path(pid: ProcessId) -> Option<PathBuf> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
    };
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, u32::from(pid)) };
    if handle.is_null() {
        return None;
    }
    let mut buffer = [0u16; 512];
    let mut size = buffer.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut size) };
    unsafe { CloseHandle(handle) };
    if ok == 0 || size == 0 {
        return None;
    }
    Some(PathBuf::from(String::from_utf16_lossy(
        &buffer[..size as usize],
    )))
}

/// A value ending in a backslash would otherwise escape the closing quote,
/// leaving the quoted region open so every later argument is swallowed into
/// it. The run is doubled; backslashes elsewhere stay literal. An embedded
/// quote is doubled rather than backslash-escaped, since doubling is what
/// satisfies the consecutive-quote rule and the form `cmd` itself accepts.
/// An empty argument is still wrapped in its own pair of quotes so it
/// survives as a token instead of vanishing between two spaces.
#[test]
fn a_trailing_backslash_cannot_escape_the_closing_quote() {
    assert_eq!(
        super::quote_arg("C:\\Program Files\\"),
        "\"C:\\Program Files\\\\\""
    );
    assert_eq!(
        super::quote_arg("C:\\dir\\\\"),
        "C:\\dir\\\\",
        "an unquoted value has no closing quote for a backslash to escape"
    );
    assert_eq!(
        super::quote_arg("no trailing\\slash"),
        "\"no trailing\\slash\""
    );
    assert_eq!(super::quote_arg("plain"), "plain");
    assert_eq!(
        super::quote_arg("a\"b"),
        "\"a\"\"b\"",
        "an embedded quote is doubled, not backslash-escaped"
    );
    assert_eq!(
        super::quote_arg(""),
        "\"\"",
        "an empty argument must still occupy its own quoted token"
    );
}

#[path = "launch_renderer_tests.rs"]
mod renderer_tests;
