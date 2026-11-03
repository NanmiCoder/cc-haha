use agent_desktop_core::{AdapterError, ErrorCode, ProcessId};
#[cfg(target_os = "macos")]
use std::mem::{MaybeUninit, size_of};

const TOKEN_PREFIX: &str = "macos-proc-v1";
const MAX_LAUNCH_TIME_DELTA_SECONDS: f64 = 5.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ProcessIdentity {
    pid: i32,
    start_seconds: u64,
    start_microseconds: u64,
}

impl ProcessIdentity {
    #[cfg(target_os = "macos")]
    pub(crate) fn capture(pid: i32) -> Result<Option<Self>, AdapterError> {
        if pid <= 0 {
            return Err(AdapterError::new(
                ErrorCode::InvalidArgs,
                "Process identity requires a positive PID",
            ));
        }
        let mut info = MaybeUninit::<libc::proc_bsdinfo>::zeroed();
        let expected = i32::try_from(size_of::<libc::proc_bsdinfo>())
            .map_err(|_| AdapterError::internal("proc_bsdinfo size exceeds the libproc ABI"))?;
        let returned = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                info.as_mut_ptr().cast(),
                expected,
            )
        };
        if returned <= 0 {
            return classify_missing_or_inaccessible(pid, std::io::Error::last_os_error());
        }
        if returned != expected {
            return Err(AdapterError::new(
                ErrorCode::AppUnresponsive,
                format!("libproc returned an incomplete process identity for pid {pid}"),
            )
            .with_details(serde_json::json!({
                "pid": pid,
                "returned_bytes": returned,
                "expected_bytes": expected,
            })));
        }
        let info = unsafe { info.assume_init() };
        let expected_pid = u32::try_from(pid).map_err(|_| {
            AdapterError::internal("validated macOS pid_t could not convert to u32")
        })?;
        if info.pbi_pid != expected_pid {
            return Err(AdapterError::new(
                ErrorCode::AppUnresponsive,
                "libproc returned a mismatched process identity",
            ));
        }
        Ok(Some(Self {
            pid,
            start_seconds: info.pbi_start_tvsec,
            start_microseconds: info.pbi_start_tvusec,
        }))
    }

    #[cfg(not(target_os = "macos"))]
    pub(crate) fn capture(pid: i32) -> Result<Option<Self>, AdapterError> {
        let _ = pid;
        Err(AdapterError::not_supported("macos_process_identity"))
    }

    pub(crate) fn pid(self) -> i32 {
        self.pid
    }

    pub(crate) fn launch_time_seconds(self) -> f64 {
        self.start_seconds as f64 + self.start_microseconds as f64 / 1_000_000.0
    }

    pub(crate) fn token(self) -> String {
        format!(
            "{TOKEN_PREFIX}:{}:{}",
            self.start_seconds, self.start_microseconds
        )
    }

    pub(crate) fn matches_launch_time(self, launch_time: f64) -> bool {
        if !launch_time.is_finite() || launch_time <= 0.0 {
            return false;
        }
        (self.launch_time_seconds() - launch_time).abs() <= MAX_LAUNCH_TIME_DELTA_SECONDS
    }

    /// Absent evidence is not conflicting evidence. NSWorkspace reports no
    /// launch date for a process it did not start — a system application
    /// already running at login answers zero — so there is nothing to
    /// reconcile against libproc and the caller must rely on its other
    /// identity checks instead of failing.
    pub(crate) fn conflicts_with_launch_time(self, launch_time: f64) -> bool {
        if !launch_time.is_finite() || launch_time <= 0.0 {
            return false;
        }
        !self.matches_launch_time(launch_time)
    }

    pub(crate) fn still_matches(self) -> Result<bool, AdapterError> {
        Ok(Self::capture(self.pid)?.is_some_and(|current| current == self))
    }
}

pub(crate) fn token_for_pid(pid: i32) -> Result<Option<String>, AdapterError> {
    Ok(ProcessIdentity::capture(pid)?.map(ProcessIdentity::token))
}

pub(crate) fn matches_instance(pid: i32, token: &str) -> Result<bool, AdapterError> {
    let expected = parse_token(pid, token)?;
    expected.still_matches()
}

pub(crate) fn instance_matches_launch_time(
    pid: i32,
    token: &str,
    launch_time: f64,
) -> Result<bool, AdapterError> {
    Ok(parse_token(pid, token)?.matches_launch_time(launch_time))
}

pub(crate) fn require_core(
    process: &agent_desktop_core::ProcessIdentity,
) -> Result<ProcessIdentity, AdapterError> {
    let expected = parse_token(to_pid_t(process.pid)?, &process.instance)?;
    if expected.still_matches()? {
        Ok(expected)
    } else {
        Err(AdapterError::new(
            ErrorCode::AppUnresponsive,
            "Target process instance is no longer running",
        )
        .with_details(serde_json::json!({
            "pid": process.pid,
            "process_instance": process.instance,
            "complete": false,
        })))
    }
}

pub(crate) fn to_pid_t(pid: ProcessId) -> Result<i32, AdapterError> {
    i32::try_from(pid).map_err(|_| {
        AdapterError::new(
            ErrorCode::InvalidArgs,
            format!("Process id {pid} exceeds the macOS pid_t range"),
        )
        .with_details(serde_json::json!({
            "pid": pid,
            "max_pid": i32::MAX,
            "complete": false,
            "retryable": false,
        }))
    })
}

pub(crate) fn from_pid_t(pid: i32) -> Result<ProcessId, AdapterError> {
    ProcessId::try_from(pid).map_err(|_| {
        AdapterError::new(
            ErrorCode::AppUnresponsive,
            format!("macOS returned invalid process id {pid}"),
        )
        .with_details(serde_json::json!({
            "pid": pid,
            "complete": false,
            "retryable": false,
        }))
    })
}

fn parse_token(pid: i32, token: &str) -> Result<ProcessIdentity, AdapterError> {
    let mut parts = token.split(':');
    let prefix = parts.next();
    let seconds = parts.next().and_then(|value| value.parse::<u64>().ok());
    let microseconds = parts.next().and_then(|value| value.parse::<u64>().ok());
    if prefix != Some(TOKEN_PREFIX)
        || seconds.is_none()
        || microseconds.is_none()
        || parts.next().is_some()
    {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Malformed macOS process instance token",
        ));
    }
    Ok(ProcessIdentity {
        pid,
        start_seconds: seconds.unwrap_or_default(),
        start_microseconds: microseconds.unwrap_or_default(),
    })
}

#[cfg(target_os = "macos")]
fn classify_missing_or_inaccessible(
    pid: i32,
    process_error: std::io::Error,
) -> Result<Option<ProcessIdentity>, AdapterError> {
    match process_error.raw_os_error() {
        Some(libc::ESRCH) => return Ok(None),
        Some(libc::EPERM) => return Err(process_identity_permission_error(pid, process_error)),
        _ => {}
    }
    let probe = unsafe { libc::kill(pid, 0) };
    if probe == 0 {
        return Err(AdapterError::new(
            ErrorCode::AppUnresponsive,
            format!("libproc could not read the live process identity for pid {pid}"),
        )
        .with_platform_detail(process_error.to_string()));
    }
    let error = std::io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::ESRCH) => Ok(None),
        Some(libc::EPERM) => Err(process_identity_permission_error(pid, error)),
        _ => Err(AdapterError::new(
            ErrorCode::AppUnresponsive,
            format!("Could not determine whether pid {pid} is still live"),
        )
        .with_platform_detail(error.to_string())),
    }
}

#[cfg(target_os = "macos")]
fn process_identity_permission_error(pid: i32, error: std::io::Error) -> AdapterError {
    AdapterError::new(
        ErrorCode::PermDenied,
        format!("Permission denied reading process identity for pid {pid}"),
    )
    .with_platform_detail(error.to_string())
    .with_details(serde_json::json!({
        "kind": "process_identity_permission",
        "source": "libproc",
        "operation": "PROC_PIDTBSDINFO",
        "pid": pid,
        "complete": false,
        "retryable": false,
    }))
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn current_process_token_roundtrips_and_matches() {
        let pid = i32::try_from(std::process::id()).expect("test pid fits macOS pid_t");
        let token = token_for_pid(pid).unwrap().expect("current process token");

        assert!(matches_instance(pid, &token).unwrap());
    }

    #[test]
    fn malformed_token_is_not_treated_as_a_process_match() {
        let pid = i32::try_from(std::process::id()).expect("test pid fits macOS pid_t");
        let error = matches_instance(pid, "broken").expect_err("malformed token must fail closed");

        assert_eq!(error.code, ErrorCode::InvalidArgs);
    }

    #[test]
    fn core_pid_conversion_is_checked_at_the_macos_boundary() {
        let max_pid_t = ProcessId::new(u32::try_from(i32::MAX).unwrap());
        assert_eq!(to_pid_t(max_pid_t).unwrap(), i32::MAX);

        let overflow = to_pid_t(ProcessId::new(u32::MAX)).unwrap_err();
        assert_eq!(overflow.code, ErrorCode::InvalidArgs);

        let invalid_native = from_pid_t(-1).unwrap_err();
        assert_eq!(invalid_native.code, ErrorCode::AppUnresponsive);
    }

    #[test]
    fn missing_process_has_no_identity() {
        assert!(ProcessIdentity::capture(999_999).unwrap().is_none());
    }

    #[test]
    fn launch_time_match_rejects_a_reused_pid_generation() {
        let identity = ProcessIdentity {
            pid: 42,
            start_seconds: 1_700_000_000,
            start_microseconds: 250_000,
        };

        assert!(identity.matches_launch_time(1_700_000_000.25));
        assert!(!identity.matches_launch_time(1_700_000_006.0));
        assert!(!identity.matches_launch_time(0.0));
        assert!(identity.conflicts_with_launch_time(1_700_000_006.0));
        assert!(!identity.conflicts_with_launch_time(1_700_000_000.25));
        assert!(!identity.conflicts_with_launch_time(0.0));
        assert!(!identity.conflicts_with_launch_time(f64::NAN));
    }

    #[test]
    fn instance_launch_time_match_reuses_the_process_token_contract() {
        let identity = ProcessIdentity {
            pid: 42,
            start_seconds: 1_700_000_000,
            start_microseconds: 250_000,
        };
        let token = identity.token();

        assert!(instance_matches_launch_time(42, &token, 1_700_000_000.25).unwrap());
        assert!(!instance_matches_launch_time(42, &token, 1_700_000_006.0).unwrap());
    }

    #[test]
    fn libproc_permission_error_is_structured_for_owner_diagnostics() {
        let error =
            classify_missing_or_inaccessible(418, std::io::Error::from_raw_os_error(libc::EPERM))
                .unwrap_err();

        assert_eq!(error.code, ErrorCode::PermDenied);
        let details = error.details.unwrap();
        assert_eq!(details["kind"], "process_identity_permission");
        assert_eq!(details["source"], "libproc");
        assert_eq!(details["pid"], 418);
        assert_eq!(details["retryable"], false);
    }
}
