use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode};

const MAX_BRIDGE_BYTES: usize = 1024 * 1024;
const MAX_LAUNCH_TIME_DELTA_SECONDS: f64 = 5.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TerminationOutcome {
    Accepted,
    Missing,
    Rejected,
    IdentityMismatch,
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct TerminateResult {
    status: u8,
    delivery_started: u8,
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct BytesResult {
    status: u8,
    failure_field: *const std::ffi::c_char,
    failure_index: i32,
    failure_pid: i32,
    bytes: *mut u8,
    length: usize,
}

/// Only a launch date that is present and disagrees with the expected
/// identity is conflicting evidence. NSWorkspace reports no launch date for
/// a process it did not start, and the bridge passes that absence
/// separately, so any present value — epoch, negative, or infinite — keeps
/// the same refusal rule the direct comparison applied.
#[cfg(target_os = "macos")]
pub(crate) fn termination_launch_time_conflict(
    expected: f64,
    observed: f64,
    present: bool,
) -> bool {
    present && (observed - expected).abs() > MAX_LAUNCH_TIME_DELTA_SECONDS
}

#[cfg(target_os = "macos")]
extern "C" fn termination_launch_time_conflict_ffi(
    expected: f64,
    observed: f64,
    present: bool,
) -> bool {
    std::panic::catch_unwind(|| termination_launch_time_conflict(expected, observed, present))
        .unwrap_or(true)
}

#[cfg(target_os = "macos")]
pub(crate) fn terminate(
    pid: i32,
    expected_launch_time: f64,
    force: bool,
) -> Result<TerminationOutcome, AdapterError> {
    let result = unsafe {
        agent_desktop_terminate_application(
            pid,
            expected_launch_time,
            u8::from(force),
            termination_launch_time_conflict_ffi,
        )
    };
    match result.status {
        0 => Ok(TerminationOutcome::Accepted),
        1 => Ok(TerminationOutcome::Missing),
        2 => Ok(TerminationOutcome::Rejected),
        5 => Ok(TerminationOutcome::IdentityMismatch),
        3 => Err(bridge_error(
            "termination",
            result.status,
            result.delivery_started != 0,
        )),
        status => Err(bridge_error("termination", status, false)),
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn ensure_cocoa_multithreaded() -> Result<(), String> {
    let status = unsafe { agent_desktop_ensure_cocoa_multithreaded() };
    match status {
        0 => Ok(()),
        1 => Err("NSThread initialization returned null".into()),
        2 => Err("NSThread initialization did not finish within one second".into()),
        3 => Err("Foundation did not enter multithreaded mode".into()),
        4 => Err("Foundation raised an exception during multithreaded initialization".into()),
        _ => Err("Foundation returned an invalid initialization status".into()),
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn workspace_snapshot_json() -> Result<Vec<u8>, AdapterError> {
    let result = unsafe { agent_desktop_copy_workspace_snapshot_json() };
    let bytes = BridgeBytes(result.bytes);
    if result.status != 0 {
        return Err(workspace_snapshot_error(&result));
    }
    if result.length > MAX_BRIDGE_BYTES || (result.length > 0 && bytes.0.is_null()) {
        return Err(bridge_error("workspace_snapshot", u8::MAX, false));
    }
    if result.length == 0 {
        return Ok(Vec::new());
    }
    Ok(unsafe { std::slice::from_raw_parts(bytes.0, result.length) }.to_vec())
}

#[cfg(target_os = "macos")]
fn workspace_snapshot_error(result: &BytesResult) -> AdapterError {
    let field = if result.failure_field.is_null() {
        None
    } else {
        Some(
            unsafe { std::ffi::CStr::from_ptr(result.failure_field) }
                .to_string_lossy()
                .into_owned(),
        )
    };
    let mut details = serde_json::json!({
        "kind": "appkit_bridge",
        "operation": "workspace_snapshot",
        "status": result.status,
        "failure_field": field,
        "failure_index": (result.failure_index >= 0).then_some(result.failure_index),
        "failure_pid": (result.failure_pid > 0).then_some(result.failure_pid),
        "retryable": true,
    });
    if let Some(fields) = details.as_object_mut() {
        fields.retain(|_, value| !value.is_null());
    }
    bridge_error("workspace_snapshot", result.status, false).with_details(details)
}

#[cfg(target_os = "macos")]
struct BridgeBytes(*mut u8);

#[cfg(target_os = "macos")]
impl Drop for BridgeBytes {
    fn drop(&mut self) {
        unsafe { agent_desktop_free_bridge_bytes(self.0) };
    }
}

#[cfg(target_os = "macos")]
fn bridge_error(operation: &str, status: u8, delivery_started: bool) -> AdapterError {
    let disposition = if delivery_started {
        DeliverySemantics::uncertain()
    } else {
        DeliverySemantics::not_delivered()
    };
    AdapterError::new(
        ErrorCode::AppUnresponsive,
        format!("The macOS AppKit bridge failed during {operation}"),
    )
    .with_suggestion("Retry after macOS finishes updating application state")
    .with_details(serde_json::json!({
        "kind": "appkit_bridge",
        "operation": operation,
        "status": status,
        "retryable": !delivery_started,
    }))
    .with_disposition(disposition)
}

/// Where a process is in its startup. `NoRecord` covers both a process that
/// exited and one that has not registered with the window server yet, so it
/// answers neither question on its own and the caller has to ask libproc which
/// of the two it is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StartupState {
    Starting,
    Finished,
    NoRecord,
}

/// An application that finished starting up has already created whatever
/// windows its launch produces.
#[cfg(target_os = "macos")]
pub(crate) fn startup_state(pid: i32) -> StartupState {
    match unsafe { agent_desktop_app_finished_launching(pid) } {
        0 => StartupState::Starting,
        1 => StartupState::Finished,
        _ => StartupState::NoRecord,
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn startup_state(_pid: i32) -> StartupState {
    StartupState::NoRecord
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn agent_desktop_terminate_application(
        pid: i32,
        expected_launch_time: f64,
        force: u8,
        launch_time_conflict: extern "C" fn(f64, f64, bool) -> bool,
    ) -> TerminateResult;
    fn agent_desktop_app_finished_launching(pid: i32) -> i32;
    fn agent_desktop_ensure_cocoa_multithreaded() -> u8;
    fn agent_desktop_copy_workspace_snapshot_json() -> BytesResult;
    fn agent_desktop_free_bridge_bytes(bytes: *mut u8);
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn terminate(
    _pid: i32,
    _expected_launch_time: f64,
    _force: bool,
) -> Result<TerminationOutcome, AdapterError> {
    Err(AdapterError::not_supported("terminate application"))
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn ensure_cocoa_multithreaded() -> Result<(), String> {
    Err("AppKit is unavailable".into())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn workspace_snapshot_json() -> Result<Vec<u8>, AdapterError> {
    Err(AdapterError::not_supported(
        "workspace application snapshot",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn workspace_snapshot_bridge_failures_are_structured() {
        let error = bridge_error("workspace_snapshot", 2, false);

        assert_eq!(error.code, ErrorCode::AppUnresponsive);
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
        let details = error.details.unwrap();
        assert_eq!(details["kind"], "appkit_bridge");
        assert_eq!(details["operation"], "workspace_snapshot");
        assert_eq!(details["status"], 2);
        assert_eq!(details["retryable"], true);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn workspace_snapshot_failure_identifies_field_without_exposing_application_name() {
        let field = b"application_name\0";
        let result = BytesResult {
            status: 2,
            failure_field: field.as_ptr().cast(),
            failure_index: 7,
            failure_pid: 123,
            bytes: std::ptr::null_mut(),
            length: 0,
        };

        let details = workspace_snapshot_error(&result).details.unwrap();
        assert_eq!(details["kind"], "appkit_bridge");
        assert_eq!(details["operation"], "workspace_snapshot");
        assert_eq!(details["status"], 2);
        assert_eq!(details["failure_field"], "application_name");
        assert_eq!(details["failure_index"], 7);
        assert_eq!(details["failure_pid"], 123);
        assert_eq!(details["retryable"], true);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn workspace_snapshot_failure_without_context_omits_the_unset_fields() {
        let result = BytesResult {
            status: 1,
            failure_field: std::ptr::null(),
            failure_index: -1,
            failure_pid: 0,
            bytes: std::ptr::null_mut(),
            length: 0,
        };

        let details = workspace_snapshot_error(&result).details.unwrap();
        for key in ["failure_field", "failure_index", "failure_pid"] {
            assert!(details.get(key).is_none(), "{key} is omitted, not null");
        }
        assert_eq!(details["status"], 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn absent_launch_date_never_conflicts_with_termination() {
        assert!(!termination_launch_time_conflict(
            1_700_000_000.25,
            0.0,
            false
        ));
        assert!(!termination_launch_time_conflict(
            1_700_000_000.25,
            1_700_000_006.0,
            false
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn present_launch_date_keeps_the_five_second_refusal() {
        let expected = 1_700_000_000.25;

        assert!(termination_launch_time_conflict(expected, 0.0, true));
        assert!(termination_launch_time_conflict(expected, -4.0, true));
        assert!(termination_launch_time_conflict(
            expected,
            f64::INFINITY,
            true
        ));
        assert!(termination_launch_time_conflict(
            expected,
            1_700_000_006.0,
            true
        ));
        assert!(!termination_launch_time_conflict(expected, expected, true));
        assert!(!termination_launch_time_conflict(
            expected,
            1_700_000_005.25,
            true
        ));
        assert!(!termination_launch_time_conflict(expected, f64::NAN, true));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn post_selector_exception_is_delivery_uncertain() {
        let error = bridge_error("termination", 3, true);

        assert_eq!(error.disposition, DeliverySemantics::uncertain());
        assert_eq!(error.details.unwrap()["retryable"], false);
    }
}
