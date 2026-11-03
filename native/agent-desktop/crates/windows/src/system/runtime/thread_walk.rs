use super::hresult::win32_last_error;
use agent_desktop_core::{AdapterError, Deadline};

use windows_sys::Win32::System::Diagnostics::ToolHelp::THREADENTRY32;

/// `CreateToolhelp32Snapshot` reports failure as `INVALID_HANDLE_VALUE`
/// (`-1`), never as a null handle, so an `is_null` guard can never fire and
/// a failed call would read as an empty enumeration rather than an error.
/// One `TH32CS_SNAPTHREAD` walk of every thread on the desktop, feeding each
/// entry to `on_thread` until it returns `Some`, the walk runs out of
/// threads, or `deadline` expires. A caller that short-circuits on the first
/// match, like the single-pid menu-mode source, pays no budget check at all;
/// a caller that must see every thread, like the multi-pid source, pays
/// exactly one budget read per thread after the first.
///
/// The snapshot handle opened here is closed on every exit path this
/// function has: running out of threads, an early `Some` from `on_thread`,
/// and a deadline expiring mid-walk all close the same handle before
/// returning. A poller that repeats this walk every 200ms leaks one handle
/// per expired capture if any one of those paths skips the close.
pub(crate) fn walk_gui_threads<T>(
    deadline: Deadline,
    mut on_thread: impl FnMut(&THREADENTRY32) -> Option<T>,
) -> Result<Option<T>, AdapterError> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, Thread32First, Thread32Next,
    };

    #[cfg(test)]
    thread_snapshot_calls::record();

    let snapshot = if force_open_failure::is_active() {
        INVALID_HANDLE_VALUE
    } else {
        unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }
    };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(open_failure_error());
    }
    let mut entry = THREADENTRY32 {
        dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    let mut found = None;
    let mut first = true;
    let mut ok = unsafe { Thread32First(snapshot, &mut entry) };
    while ok != 0 {
        if !first {
            if let Err(error) = deadline.ensure_remaining() {
                unsafe { CloseHandle(snapshot) };
                #[cfg(test)]
                thread_snapshot_closes::record();
                return Err(error);
            }
        }
        first = false;
        if let Some(value) = on_thread(&entry) {
            found = Some(value);
            break;
        }
        ok = unsafe { Thread32Next(snapshot, &mut entry) };
    }
    unsafe { CloseHandle(snapshot) };
    #[cfg(test)]
    thread_snapshot_closes::record();
    Ok(found)
}

/// Win32 `GetLastError` -> `HRESULT_FROM_WIN32` into the shared HRESULT
/// table, the convention every native-failure module in this crate uses for
/// its own local errors.
fn open_failure_error() -> AdapterError {
    crate::system::window::listing_retry::narrow_to_permitted_codes(win32_last_error(
        "CreateToolhelp32Snapshot failed for classic menu-mode detection",
    ))
}

/// Counts snapshot handle opens so a test can prove every `ToolHelp`
/// snapshot this walk creates is matched by exactly one close, across every
/// exit path.
#[cfg(test)]
pub(crate) mod thread_snapshot_calls {
    use std::cell::Cell;

    thread_local! {
        static COUNT: Cell<usize> = const { Cell::new(0) };
    }

    pub(crate) fn record() {
        crate::system::fixture::call_counter::record(&COUNT);
    }

    pub(crate) fn take() -> usize {
        crate::system::fixture::call_counter::take(&COUNT)
    }
}

/// Counts snapshot handle closes so a test can prove every opened `ToolHelp`
/// snapshot is closed on every exit path. The deadline check inside the walk
/// returns early, and an early return that skips the close leaks a handle per
/// expired capture on a loop that polls every 200ms.
#[cfg(test)]
pub(crate) mod thread_snapshot_closes {
    use std::cell::Cell;

    thread_local! {
        static COUNT: Cell<usize> = const { Cell::new(0) };
    }

    pub(crate) fn record() {
        crate::system::fixture::call_counter::record(&COUNT);
    }

    pub(crate) fn take() -> usize {
        crate::system::fixture::call_counter::take(&COUNT)
    }
}

/// Substitutes the documented failure return of `CreateToolhelp32Snapshot` so
/// a test can drive the guard against the value the API actually reports.
/// Without this the guard is only assertable as a claim about a constant, and
/// a guard rewritten to compare against the null handle would keep every test
/// green while never firing on a real failure.
#[cfg(test)]
pub(in crate::system) mod force_open_failure {
    use std::cell::Cell;

    thread_local! {
        static ACTIVE: Cell<bool> = const { Cell::new(false) };
    }

    pub(super) fn is_active() -> bool {
        ACTIVE.with(Cell::get)
    }

    pub(crate) fn with<R>(run: impl FnOnce() -> R) -> R {
        crate::system::fixture::test_support::with_flag(&ACTIVE, true, run)
    }
}

#[cfg(not(test))]
mod force_open_failure {
    pub(super) fn is_active() -> bool {
        false
    }
}
