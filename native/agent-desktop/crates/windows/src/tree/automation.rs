use agent_desktop_core::{AdapterError, Deadline, ErrorCode};

#[path = "automation_classify.rs"]
mod classify;

pub(crate) use classify::uia_failure_disposition;
pub use classify::{
    ERR_ALREADY_RUNNING, ERR_FORMAT, ERR_INACTIVE, ERR_INVALID_ARG, ERR_INVALID_OBJECT, ERR_NONE,
    ERR_NOTFOUND, ERR_NULL_PTR, ERR_TIMEOUT, ERR_TYPE, UiaFailure, root_resolution_error,
    uia_failure_error,
};

/// Longest this crate will wait to learn whether a window thread is pumping.
///
/// Bounded independently of the operation deadline: the probe exists to avoid
/// an unbounded block, so spending the whole remaining budget on it would
/// defeat its purpose.
const PUMP_PROBE_CAP_MS: u64 = 2_000;

/// How long a UI Automation call may wait to reach a target's provider.
///
/// This is a backstop against an unbounded hang, not a latency budget - the
/// operation `Deadline` bounds latency and is checked around every call. It is
/// UI Automation's own documented default, kept explicit so the value is a
/// decision rather than an inheritance.
///
/// The already-hung case does not wait this out. `root_from_hwnd` probes with
/// `SendMessageTimeoutW` first and fails in `PUMP_PROBE_CAP_MS`; this bound
/// only catches a target that stops dispatching after answering that probe.
pub const CONNECTION_TIMEOUT_MS: u32 = 2_000;

/// How long one UI Automation transaction may take end to end.
pub const TRANSACTION_TIMEOUT_MS: u32 = 20_000;

/// Reports a window whose thread is not dispatching messages.
///
/// Distinct from a window that does not exist: the handle is valid, the
/// provider is simply unreachable, and retrying later can succeed. Stamped
/// with the same `complete`/`retryable` detail pair `uia_failure_error`
/// carries off `ReadDisposition::Retryable::retry_details()`: every consumer
/// that keys retry on this crate's errors - `resolve.rs`'s resolution retry
/// loop and core's ref-action poll alike - reads that explicit stamp, not the
/// error code, so a busy-but-alive window must carry it or it settles as a
/// dead end instead of a transient the caller can wait out.
pub fn unresponsive_window_error() -> AdapterError {
    AdapterError::new(
        ErrorCode::AppUnresponsive,
        "The window's thread is not dispatching messages",
    )
    .with_suggestion("Wait for the application to become responsive, then retry")
    .with_platform_detail("WM_GETOBJECT would block: the window thread did not answer WM_NULL")
    .with_details(serde_json::json!({
        "kind": "window_not_pumping",
        "complete": false,
        "retryable": true,
    }))
}

/// Pinned separately from `automation_tests.rs` because this crate's other
/// tests belong to a concurrent change; this predicate is a pure function of
/// the error the module already builds, so it needs no platform surface to
/// check.
#[cfg(test)]
mod unresponsive_window_error_tests {
    use super::unresponsive_window_error;

    #[test]
    fn it_carries_the_explicit_retryable_stamp_every_consumer_keys_on() {
        let error = unresponsive_window_error();

        assert!(error.is_explicitly_retryable());
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{UiaFailure, root_resolution_error, uia_failure_error};
    use crate::tree::element::UIAElement;
    use agent_desktop_core::{AdapterError, Deadline};
    use std::cell::OnceCell;
    use uiautomation::{Error as UiaError, UIAutomation, types::Handle};
    use windows::Win32::System::Com::{CLSCTX_ALL, CoCreateInstance};
    use windows::Win32::UI::Accessibility::{CUIAutomation8, IUIAutomation, IUIAutomation2};

    thread_local! {
        static CLIENT: OnceCell<ThreadClient> = const { OnceCell::new() };
    }

    /// This thread's cached client, released when the thread ends, except
    /// on the main thread. The main thread only ends as the process exits,
    /// and by the time its thread-local destructors run COM has already
    /// been torn down, so releasing the client then faults inside combase
    /// (`CGIPTable::_RevokeInterfaceFromGlobal`) and every CLI call ends in
    /// a crash report. The process is exiting, so the OS reclaims the
    /// client anyway.
    struct ThreadClient {
        client: std::mem::ManuallyDrop<UIAutomation>,
        on_main_thread: bool,
    }

    impl Drop for ThreadClient {
        fn drop(&mut self) {
            if !self.on_main_thread {
                unsafe { std::mem::ManuallyDrop::drop(&mut self.client) };
            }
        }
    }

    /// Serializes the first UI Automation touch across threads.
    ///
    /// UI Automation's client core initializes lazily on first use and that
    /// initialization is **not re-entrant**: when several threads first reach
    /// it at once, all but one abort with `E_FAIL` and the message "Re-Entrant
    /// CheckInit() call, aborting". Measured on this box as three concurrent
    /// `get_root_element` calls, of which two failed instantly - not a
    /// timeout, an outright refusal.
    ///
    /// Creating the client is not enough to trigger it; the first *call* is.
    /// So the lock is held across a warm-up call, and released once the
    /// process-wide core is up. Per-thread clients are safe from then on.
    static FIRST_TOUCH: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Splits a crate error onto the `result()` discriminator.
    pub fn failure_of(error: &UiaError) -> UiaFailure {
        match error.result() {
            Some(hresult) => UiaFailure::Hresult(hresult.0),
            None => UiaFailure::Sentinel(error.code()),
        }
    }

    pub fn uia_error(error: &UiaError, context: &str) -> AdapterError {
        uia_failure_error(failure_of(error), context)
    }

    /// Hands out this thread's UI Automation client.
    ///
    /// Constructed by direct `CoCreateInstance`, never through
    /// `UIAutomation::new()`. `new()` would call `CoInitializeEx` itself: on a
    /// thread already in the MTA that returns `S_FALSE` and permanently leaks
    /// one initialization count, and on any STA host thread it fails outright
    /// with `RPC_E_CHANGED_MODE`. Apartment bootstrap owns the apartment
    /// elsewhere, so this accessor asserts the precondition instead of
    /// establishing it. See `create_bounded_client` for which CLSID, and why.
    pub fn automation_client() -> Result<UIAutomation, AdapterError> {
        CLIENT.with(|cell| {
            if let Some(cached) = cell.get() {
                return Ok((*cached.client).clone());
            }
            let client = create_serialized_client()?;
            let _ = cell.set(ThreadClient {
                client: std::mem::ManuallyDrop::new(client.clone()),
                on_main_thread: std::thread::current().name() == Some("main"),
            });
            Ok(client)
        })
    }

    /// Builds this thread's client without racing UI Automation's own lazy
    /// initialization against another thread's.
    fn create_serialized_client() -> Result<UIAutomation, AdapterError> {
        let guard = FIRST_TOUCH.lock();
        let client = create_bounded_client()?;
        let _ = client.get_root_element();
        drop(guard);
        Ok(client)
    }

    /// Builds a client whose calls are bounded, and fails rather than hand
    /// back one whose calls are not.
    ///
    /// `UIAutomation::new_direct()` is `CoCreateInstance(&CUIAutomation, ...)`,
    /// and that object does not support `IUIAutomation2`, so its calls carry no
    /// timeout at all: measured against a window that stopped dispatching,
    /// `ElementFromHandle` did not return inside a 30 s watchdog.
    /// `CUIAutomation8` exposes `SetConnectionTimeout`, and the same call then
    /// returns `UIA_E_TIMEOUT` inside the bound.
    ///
    /// This keeps every property `new_direct()` was chosen for - it is the same
    /// direct `CoCreateInstance`, it never calls `CoInitializeEx`, so it works
    /// inside an STA host and leaks no initialization count in a long-lived
    /// process. Only the CLSID differs.
    ///
    /// There is deliberately **no fallback to the unbounded client**. A
    /// fallback would silently trade the hang guarantee for availability on a
    /// platform that cannot occur: `CUIAutomation8` has shipped since
    /// Windows 8, the product's floor is Windows 10 1809, and it is measured
    /// present on both build 17763 and the Server 2025 CI image. A client
    /// whose calls cannot be bounded is one this crate should refuse, not one
    /// it should quietly accept.
    fn create_bounded_client() -> Result<UIAutomation, AdapterError> {
        let client: IUIAutomation2 = unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_ALL) }
            .map_err(|error| unbounded_client_error(error.code().0))?;
        unsafe {
            client
                .SetConnectionTimeout(super::CONNECTION_TIMEOUT_MS)
                .map_err(|error| unbounded_client_error(error.code().0))?;
            client
                .SetTransactionTimeout(super::TRANSACTION_TIMEOUT_MS)
                .map_err(|error| unbounded_client_error(error.code().0))?;
        }
        let automation: IUIAutomation = client.into();
        Ok(UIAutomation::from(automation))
    }

    fn unbounded_client_error(hresult: i32) -> AdapterError {
        uia_failure_error(
            UiaFailure::Hresult(hresult),
            "create a UI Automation client whose calls are bounded",
        )
        .with_suggestion(
            "This build does not provide CUIAutomation8; observation is refused rather than run against a client that cannot time out",
        )
    }

    /// Resolves a top-level window handle to its UI Automation root element.
    ///
    /// `ElementFromHandle` sends `WM_GETOBJECT` to the target's window thread,
    /// and a cross-thread `SendMessage` has no timeout of its own. A `Deadline`
    /// checked around the call therefore **cannot** interrupt it: against a
    /// target that has stopped pumping, the call blocks and the deadline is
    /// only observed once it returns.
    ///
    /// So the target is asked first whether it is pumping at all, with
    /// `SendMessageTimeoutW(WM_NULL, SMTO_ABORTIFHUNG)` - the documented way to
    /// put a bound on exactly this question. A target that is already hung
    /// becomes a structured `APP_UNRESPONSIVE` instead of an indefinite block.
    ///
    /// The probe is the fast, precise answer, not the safety net. A target
    /// that answers it and then stops dispatching cannot be caught by any
    /// preflight, so the bound that actually holds is the client's own
    /// `ConnectionTimeout` (see `create_bounded_client`): that call returns
    /// `UIA_E_TIMEOUT` rather than blocking. The probe exists because it turns
    /// an already-hung target into a clearer error, sooner, than waiting the
    /// connection timeout out.
    pub fn root_from_hwnd(hwnd: isize, deadline: Deadline) -> Result<UIAElement, AdapterError> {
        deadline.ensure_remaining()?;
        let client = automation_client()?;
        if !window_exists(hwnd) {
            return Err(root_resolution_error(UiaFailure::Sentinel(
                super::ERR_NOTFOUND,
            )));
        }
        let probe_ms = deadline.remaining_ms().min(super::PUMP_PROBE_CAP_MS);
        if !window_is_pumping(hwnd, probe_ms) {
            return Err(super::unresponsive_window_error());
        }
        let element = client
            .element_from_handle(Handle::from(hwnd))
            .map_err(|error| root_resolution_error(failure_of(&error)))?;
        deadline.ensure_remaining()?;
        Ok(UIAElement::from(element))
    }

    /// Reports whether a handle still addresses a live window.
    ///
    /// Asked before the pump probe so the two failures stay distinct: a handle
    /// that addresses nothing is a missing window, which is the mapping A14-5
    /// measured, while a live window that will not answer is an unresponsive
    /// application. Collapsing them would make a destroyed window look like a
    /// hung one and send a caller into a pointless retry.
    pub fn window_exists(hwnd: isize) -> bool {
        use windows_sys::Win32::UI::WindowsAndMessaging::IsWindow;
        hwnd != 0 && unsafe { IsWindow(hwnd as *mut std::ffi::c_void) } != 0
    }

    /// Asks whether a window's thread is dispatching messages, without
    /// blocking on it.
    ///
    /// `WM_NULL` is the no-op message every window proc handles, and
    /// `SMTO_ABORTIFHUNG` makes the call return immediately when the target is
    /// already known to be hung rather than waiting out the timeout.
    pub fn window_is_pumping(hwnd: isize, timeout_ms: u64) -> bool {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SMTO_ABORTIFHUNG, SendMessageTimeoutW, WM_NULL,
        };
        let mut answer: usize = 0;
        let sent = unsafe {
            SendMessageTimeoutW(
                hwnd as *mut std::ffi::c_void,
                WM_NULL,
                0,
                0,
                SMTO_ABORTIFHUNG,
                u32::try_from(timeout_ms.max(1)).unwrap_or(u32::MAX),
                &mut answer,
            )
        };
        sent != 0
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::{UiaFailure, root_resolution_error};
    use crate::tree::element::{CannedElement, UIAElement};
    use agent_desktop_core::{AdapterError, Deadline};

    /// Canned arm so the classifier tests, and every module that calls the
    /// resolver, compile and run on a non-Windows lane.
    pub fn root_from_hwnd(hwnd: isize, deadline: Deadline) -> Result<UIAElement, AdapterError> {
        deadline.ensure_remaining()?;
        if hwnd == 0 {
            return Err(root_resolution_error(UiaFailure::Sentinel(
                super::ERR_NOTFOUND,
            )));
        }
        Ok(UIAElement::from(CannedElement))
    }

    /// No windows exist on the non-Windows lane, so no handle is a live window -
    /// the liveness re-verification consistently reports the window gone.
    pub fn window_exists(hwnd: isize) -> bool {
        hwnd != 0 && false
    }
}

pub use imp::root_from_hwnd;

#[cfg(target_os = "windows")]
pub use imp::{automation_client, failure_of, uia_error, window_exists, window_is_pumping};

#[cfg(not(target_os = "windows"))]
pub use imp::window_exists;

/// Rejects a window handle that cannot address a window before it reaches the
/// COM layer, so a null handle is an argument error rather than a COM failure.
pub fn validate_window_handle(hwnd: isize, deadline: Deadline) -> Result<(), AdapterError> {
    deadline.ensure_remaining()?;
    if hwnd == 0 {
        return Err(
            AdapterError::new(ErrorCode::InvalidArgs, "Window handle is empty")
                .with_suggestion("Pass a window handle obtained from a window listing"),
        );
    }
    Ok(())
}

#[cfg(test)]
#[path = "automation_tests.rs"]
mod tests;
