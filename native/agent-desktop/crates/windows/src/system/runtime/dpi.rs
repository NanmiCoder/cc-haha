use agent_desktop_core::{AdapterError, ErrorCode};

const DPI_CONTEXT_ALREADY_SET_ERROR: u32 = 5;

#[cfg(target_os = "windows")]
const _: () =
    assert!(DPI_CONTEXT_ALREADY_SET_ERROR == windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DpiAwarenessOutcome {
    PerMonitorV2Applied,
    AlreadySet,
}

/// Applies `DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2` to this process,
/// judged on the call's return alone: awareness is never read back, because
/// `GetProcessDpiAwareness` has no V2 enumerant and reports V2 as V1.
/// `ERROR_ACCESS_DENIED` means the process or its host already fixed the
/// awareness context, which is success, not failure.
pub(crate) fn ensure_per_monitor_v2() -> Result<DpiAwarenessOutcome, AdapterError> {
    let (call_succeeded, last_error) = imp::set_process_per_monitor_v2();
    classify_dpi_awareness_call(call_succeeded, last_error).map_err(dpi_awareness_failure)
}

pub(crate) fn classify_dpi_awareness_call(
    call_succeeded: bool,
    last_error: u32,
) -> Result<DpiAwarenessOutcome, u32> {
    match (call_succeeded, last_error) {
        (true, _) => Ok(DpiAwarenessOutcome::PerMonitorV2Applied),
        (false, DPI_CONTEXT_ALREADY_SET_ERROR) => Ok(DpiAwarenessOutcome::AlreadySet),
        (false, failure) => Err(failure),
    }
}

fn dpi_awareness_failure(last_error: u32) -> AdapterError {
    AdapterError::new(
        ErrorCode::Internal,
        "Per-monitor-v2 DPI awareness could not be established for this process",
    )
    .with_platform_detail(format!(
        "SetProcessDpiAwarenessContext Win32 error {last_error}"
    ))
    .with_suggestion(
        "Rerun from a process whose host has not locked an incompatible DPI awareness context",
    )
}

#[cfg(target_os = "windows")]
mod imp {
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::UI::HiDpi::{
        DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext,
    };

    pub(super) fn set_process_per_monitor_v2() -> (bool, u32) {
        let call_succeeded =
            unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) }
                != 0;
        if call_succeeded {
            (true, 0)
        } else {
            (false, unsafe { GetLastError() })
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    pub(super) fn set_process_per_monitor_v2() -> (bool, u32) {
        (true, 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ERROR_INVALID_PARAMETER_CODE: u32 = 87;

    #[test]
    fn a_successful_call_applies_per_monitor_v2() {
        assert_eq!(
            classify_dpi_awareness_call(true, 0),
            Ok(DpiAwarenessOutcome::PerMonitorV2Applied)
        );
    }

    #[test]
    fn access_denied_means_awareness_was_already_decided_and_is_success() {
        assert_eq!(
            classify_dpi_awareness_call(false, DPI_CONTEXT_ALREADY_SET_ERROR),
            Ok(DpiAwarenessOutcome::AlreadySet)
        );
    }

    #[test]
    fn other_win32_failures_stay_failures() {
        assert_eq!(
            classify_dpi_awareness_call(false, ERROR_INVALID_PARAMETER_CODE),
            Err(ERROR_INVALID_PARAMETER_CODE)
        );
    }

    #[test]
    fn ensure_succeeds_whether_fresh_or_already_configured() {
        ensure_per_monitor_v2().expect("the DPI bootstrap must succeed on every host lane");
    }
}
