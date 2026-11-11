use crate::AdAdapter;
use crate::convert::window::{exact_window_info_to_c, validate_exact_window_info};
use crate::error::{AdResult, set_last_error};
use crate::ffi_try::trap_panic;
use crate::types::AdExactWindowInfo;
use agent_desktop_core::{
    AdapterError, ErrorCode, WindowInfo, system::launch_result::LaunchResult,
};
use std::os::raw::c_char;

/// The C entry points hand back one window, so a launch that produced none is
/// an error at this boundary even though it is a valid result in core.
fn launched_window(launched: LaunchResult) -> Result<WindowInfo, AdapterError> {
    launched.window.ok_or_else(|| {
        AdapterError::new(
            ErrorCode::WindowNotFound,
            "Application is running, but it has presented no window",
        )
        .with_suggestion("Wait for the window before reading it.")
    })
}

/// Launches the application identified by `id` (bundle id on macOS,
/// executable path on other platforms) and, on success, writes the first
/// generation-pinned window that becomes available into `*out`. Waits for the
/// windows the launch itself produces, bounded by `timeout_ms`; zero means
/// "no wait". An application that presents no window fails with
/// `WINDOW_NOT_FOUND`.
///
/// The returned `AdExactWindowInfo` owns heap-allocated interior strings that
/// must be released with `ad_release_exact_window_fields` once done. On error
/// the out-param is zero-initialized, so calling the release fn on it is a
/// safe no-op.
///
/// # Safety
/// `adapter` must be non-null. `id` must be a non-null UTF-8 C string.
/// `out` must be a non-null writable `*mut AdExactWindowInfo`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_launch_app_exact(
    adapter: *const AdAdapter,
    id: *const c_char,
    timeout_ms: u64,
    out: *mut AdExactWindowInfo,
) -> AdResult {
    trap_panic(|| unsafe {
        crate::pointer_guard::guard_non_null!(out, c"out is null");
        *out = std::mem::zeroed();
        crate::pointer_guard::guard_non_null!(adapter, c"adapter is null");
        let id = match super::decode_app_id(id) {
            Ok(id) => id,
            Err(error) => {
                set_last_error(&error);
                return crate::error::last_error_code();
            }
        };
        let adapter = crate::adapter::acquire_adapter!(adapter);
        let options = agent_desktop_core::system::launch_options::LaunchOptions {
            timeout_ms,
            ..Default::default()
        };
        let deadline = match launch_deadline(timeout_ms) {
            Ok(deadline) => deadline,
            Err(error) => {
                set_last_error(&error);
                return crate::error::last_error_code();
            }
        };
        let lease = match adapter.inner.acquire_interaction_lease(deadline) {
            Ok(lease) => lease,
            Err(error) => {
                set_last_error(&error);
                return crate::error::last_error_code();
            }
        };
        match adapter
            .inner
            .launch_app(&id, &options, &lease)
            .and_then(launched_window)
        {
            Ok(window) => match validate_exact_window_info(&window) {
                Ok(()) => {
                    *out = exact_window_info_to_c(&window);
                    AdResult::Ok
                }
                Err(error) => {
                    set_last_error(&error);
                    crate::error::last_error_code()
                }
            },
            Err(error) => {
                set_last_error(&error);
                crate::error::last_error_code()
            }
        }
    })
}

fn launch_deadline(
    timeout_ms: u64,
) -> Result<agent_desktop_core::Deadline, agent_desktop_core::AdapterError> {
    if timeout_ms == 0 {
        crate::operation::deadline()
    } else {
        agent_desktop_core::Deadline::after(timeout_ms)
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::CString;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

    use agent_desktop_core::system::launch_options::LaunchOptions;
    use agent_desktop_core::{ActionOps, InputOps, ObservationOps, SystemOps};
    use agent_desktop_core::{
        AdapterError, Deadline, InteractionLease, ProcessId, WindowInfo, WindowState,
    };

    use super::*;

    struct LaunchProbe {
        calls: AtomicUsize,
        timeout_ms: AtomicU64,
    }

    struct LaunchAdapter {
        probe: Arc<LaunchProbe>,
    }

    impl ObservationOps for LaunchAdapter {}
    impl ActionOps for LaunchAdapter {}
    impl InputOps for LaunchAdapter {}

    impl SystemOps for LaunchAdapter {
        fn acquire_interaction_lease(
            &self,
            deadline: Deadline,
        ) -> Result<InteractionLease, AdapterError> {
            InteractionLease::guarded(deadline, ())
        }

        fn launch_app(
            &self,
            _id: &str,
            options: &LaunchOptions,
            _lease: &InteractionLease,
        ) -> Result<LaunchResult, AdapterError> {
            self.probe.calls.fetch_add(1, Ordering::SeqCst);
            self.probe
                .timeout_ms
                .store(options.timeout_ms, Ordering::SeqCst);
            Ok(LaunchResult {
                app: "Fixture".into(),
                pid: ProcessId::new(42),
                process_instance: Some("fixture-42".into()),
                window: Some(WindowInfo {
                    id: "w-launch".into(),
                    title: "Launched".into(),
                    app: "Fixture".into(),
                    pid: ProcessId::new(42),
                    process_instance: Some("fixture-42".into()),
                    bounds: None,
                    state: WindowState::default(),
                }),
                cdp: None,
                renderer: None,
                suggestion: None,
            })
        }
    }

    #[test]
    fn zero_timeout_reaches_launch_once_without_defaulting() {
        let probe = Arc::new(LaunchProbe {
            calls: AtomicUsize::new(0),
            timeout_ms: AtomicU64::new(u64::MAX),
        });
        let adapter = crate::adapter::register_adapter(crate::AdAdapter {
            inner: Box::new(LaunchAdapter {
                probe: Arc::clone(&probe),
            }),
            session_id: None,
            _session_lease: None,
        })
        .unwrap();
        let id = CString::new("Fixture").unwrap();
        let mut out: AdExactWindowInfo = unsafe { std::mem::zeroed() };

        assert_eq!(
            unsafe { ad_launch_app_exact(adapter, id.as_ptr(), 0, &mut out) },
            AdResult::Ok
        );
        assert_eq!(probe.calls.load(Ordering::SeqCst), 1);
        assert_eq!(probe.timeout_ms.load(Ordering::SeqCst), 0);

        unsafe {
            crate::windows::free_one::ad_release_exact_window_fields(&mut out);
            crate::adapter::ad_adapter_destroy(adapter);
        }
    }
}
