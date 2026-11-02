//! Session-scoped COM apartment lifetime for persistent Windows hosts.
//!
//! Nothing in the CLI binary or the FFI crate opens adapter sessions yet, so
//! this type is reachable only from `open_session` and its tests. It is not
//! dead code: `AdAdapter` in `crates/ffi/src/adapter.rs` is its natural future
//! home, with `ad_adapter_destroy` driving `close`.

use agent_desktop_core::{AdapterError, AdapterSession, Deadline, ErrorCode};

use crate::system::permissions::com_hresult_detail;
use crate::system::runtime::com_runtime::classify_mta_usage_hresult;

type MtaUsageRelease = Box<dyn FnOnce(usize) -> i32 + Send + Sync>;

struct AcquiredMtaUsage {
    cookie_address: usize,
    release: MtaUsageRelease,
}

/// Owns one session-scoped MTA usage registration, acquired as this session's
/// own `CoIncrementMTAUsage` cookie — separate from the process-lifetime
/// cookie the hosted-library bootstrap retains and never releases.
///
/// `CoIncrementMTAUsage` is the right keep-alive primitive for a session
/// because COM permits `CoDecrementMTAUsage` on its cookie from a different
/// thread than the one that acquired it. Releasing from `Drop` on whatever
/// thread runs it is therefore sound where `CoUninitialize` from the wrong
/// thread would not be, and holding the cookie as a plain address keeps the
/// type `Send` and `Sync` without any `unsafe impl`.
///
/// `close` and `Drop` both release by `Option::take` on the same field, so
/// the cookie is released exactly once whichever path runs first, and once
/// total when `close` is followed by the drop of its consumed box.
pub(crate) struct WindowsAdapterSession {
    mta_usage: Option<AcquiredMtaUsage>,
}

pub(crate) fn open(deadline: Deadline) -> Result<WindowsAdapterSession, AdapterError> {
    open_with(
        deadline,
        imp::co_increment_mta_usage,
        Box::new(imp::co_decrement_mta_usage),
    )
}

fn open_with(
    deadline: Deadline,
    acquire: impl FnOnce() -> (i32, usize),
    release: MtaUsageRelease,
) -> Result<WindowsAdapterSession, AdapterError> {
    deadline.ensure_remaining()?;
    let (hresult, cookie_address) = acquire();
    classify_mta_usage_hresult(hresult).map_err(mta_usage_acquire_failure)?;
    Ok(WindowsAdapterSession {
        mta_usage: Some(AcquiredMtaUsage {
            cookie_address,
            release,
        }),
    })
}

impl WindowsAdapterSession {
    fn release_mta_usage_once(&mut self) -> Option<i32> {
        self.mta_usage.take().map(|usage| {
            let AcquiredMtaUsage {
                cookie_address,
                release,
            } = usage;
            release(cookie_address)
        })
    }
}

impl AdapterSession for WindowsAdapterSession {
    fn close(mut self: Box<Self>) -> Result<(), AdapterError> {
        self.release_mta_usage_once().map_or(Ok(()), |hresult| {
            classify_mta_usage_hresult(hresult).map_err(mta_usage_release_failure)
        })
    }
}

impl Drop for WindowsAdapterSession {
    fn drop(&mut self) {
        let _ = self.release_mta_usage_once();
    }
}

fn mta_usage_acquire_failure(hresult: i32) -> AdapterError {
    AdapterError::new(
        ErrorCode::Internal,
        "Session-scoped COM MTA usage could not be registered",
    )
    .with_platform_detail(com_hresult_detail(hresult))
    .with_suggestion("Verify the host process allows COM initialization, then reopen the session")
}

fn mta_usage_release_failure(hresult: i32) -> AdapterError {
    AdapterError::new(
        ErrorCode::Internal,
        "Session-scoped COM MTA usage could not be released",
    )
    .with_platform_detail(com_hresult_detail(hresult))
    .with_suggestion(
        "Treat the session as closed; the process retains one leaked MTA usage until exit",
    )
}

#[cfg(target_os = "windows")]
mod imp {
    use windows_sys::Win32::System::Com::{
        CO_MTA_USAGE_COOKIE, CoDecrementMTAUsage, CoIncrementMTAUsage,
    };

    pub(super) fn co_increment_mta_usage() -> (i32, usize) {
        let mut cookie: CO_MTA_USAGE_COOKIE = std::ptr::null_mut();
        let hresult = unsafe { CoIncrementMTAUsage(&mut cookie) };
        (hresult, cookie.expose_provenance())
    }

    pub(super) fn co_decrement_mta_usage(cookie_address: usize) -> i32 {
        unsafe { CoDecrementMTAUsage(std::ptr::with_exposed_provenance_mut(cookie_address)) }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    const S_OK_HRESULT: i32 = 0;

    pub(super) fn co_increment_mta_usage() -> (i32, usize) {
        (S_OK_HRESULT, 0)
    }

    pub(super) fn co_decrement_mta_usage(_cookie_address: usize) -> i32 {
        S_OK_HRESULT
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};

    const FAKE_COOKIE_ADDRESS: usize = 0x5EED;
    const E_OUTOFMEMORY_HRESULT: i32 = 0x8007_000E_u32 as i32;

    fn counting_release(count: &Arc<AtomicU32>) -> MtaUsageRelease {
        let count = Arc::clone(count);
        Box::new(move |_| {
            count.fetch_add(1, Ordering::SeqCst);
            0
        })
    }

    fn counted_session(count: &Arc<AtomicU32>) -> WindowsAdapterSession {
        open_with(
            Deadline::after(1_000).unwrap(),
            || (0, FAKE_COOKIE_ADDRESS),
            counting_release(count),
        )
        .unwrap()
    }

    #[test]
    fn close_releases_the_acquired_cookie_exactly_once() {
        let released: Arc<Mutex<Vec<usize>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&released);
        let session = open_with(
            Deadline::after(1_000).unwrap(),
            || (0, FAKE_COOKIE_ADDRESS),
            Box::new(move |cookie_address| {
                sink.lock().unwrap().push(cookie_address);
                0
            }),
        )
        .unwrap();

        Box::new(session).close().unwrap();

        assert_eq!(*released.lock().unwrap(), vec![FAKE_COOKIE_ADDRESS]);
    }

    #[test]
    fn a_session_dropped_without_close_releases_exactly_once() {
        let count = Arc::new(AtomicU32::new(0));
        let session = counted_session(&count);

        drop(session);

        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_failing_release_reports_the_hresult_and_never_retries() {
        let count = Arc::new(AtomicU32::new(0));
        let calls = Arc::clone(&count);
        let session = open_with(
            Deadline::after(1_000).unwrap(),
            || (0, FAKE_COOKIE_ADDRESS),
            Box::new(move |_| {
                calls.fetch_add(1, Ordering::SeqCst);
                E_OUTOFMEMORY_HRESULT
            }),
        )
        .unwrap();

        let error = Box::new(session).close().unwrap_err();

        assert_eq!(error.code, ErrorCode::Internal);
        assert!(
            error
                .platform_detail
                .is_some_and(|detail| detail.contains("0x8007000E"))
        );
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_failing_acquire_is_an_error_that_schedules_no_release() {
        let count = Arc::new(AtomicU32::new(0));

        let Err(error) = open_with(
            Deadline::after(1_000).unwrap(),
            || (E_OUTOFMEMORY_HRESULT, 0),
            counting_release(&count),
        ) else {
            panic!("a failing acquire must not produce a session");
        };

        assert_eq!(error.code, ErrorCode::Internal);
        assert!(
            error
                .platform_detail
                .is_some_and(|detail| detail.contains("0x8007000E"))
        );
        assert_eq!(count.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn an_expired_deadline_times_out_before_touching_the_native_acquire() {
        let count = Arc::new(AtomicU32::new(0));

        let Err(error) = open_with(
            Deadline::after(0).unwrap(),
            || panic!("an expired deadline must not reach the native acquire"),
            counting_release(&count),
        ) else {
            panic!("an expired deadline must not produce a session");
        };

        assert_eq!(error.code, ErrorCode::Timeout);
        assert_eq!(count.load(Ordering::SeqCst), 0);
    }

    fn assert_send_sync<T: Send + Sync>() {}

    #[test]
    fn the_session_is_send_and_sync_as_a_value_and_as_a_box() {
        assert_send_sync::<WindowsAdapterSession>();
        assert_send_sync::<Box<WindowsAdapterSession>>();
    }

    #[test]
    fn a_session_moved_to_another_thread_releases_exactly_once_there() {
        let count = Arc::new(AtomicU32::new(0));
        let session = Box::new(counted_session(&count));

        std::thread::spawn(move || drop(session))
            .join()
            .expect("the thread that drops a moved session must not panic");

        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn a_real_com_mta_usage_acquires_and_closes_cleanly() {
        let session = open(Deadline::after(5_000).unwrap()).unwrap();

        Box::new(session)
            .close()
            .expect("releasing a real MTA usage cookie must succeed");
    }
}
