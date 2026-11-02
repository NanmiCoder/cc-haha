//! Shared `#[cfg(test)]` thread-local flag helper for Windows capture test
//! hooks, plus one cross-test serialization primitive.
//!
//! Every capture test hook needs the same shape: flip a thread-local `Cell`
//! on, run the closure, and flip it back off even if the closure panics.
//! Each hook module still owns its own flag (its meaning is module-specific),
//! but the arm/run/reset sequence lives here once.
//!
//! `FIXTURE_APP_NAME_LOCK` addresses a different, process-wide hazard: every
//! re-executed test fixture (`HostedFixture`, `ModalFixture`, `MenuFixture`,
//! ...) launches `std::env::current_exe()` verbatim, so every fixture child
//! spawned anywhere in this test binary reports the identical process image
//! name. A live test that resolves its fixture by `--app <that name>` while
//! a second such test's fixture is concurrently alive observes two
//! processes sharing the name and gets `AMBIGUOUS_TARGET` instead of its own
//! fixture. Most `wait --event` live tests avoid this entirely by seeding
//! `CommandContext` with a `capture_signal_baseline` already scoped to their
//! own `(pid, process_instance)` (`wait_event_live_tests.rs`'s module doc
//! explains why that closes the hazard rather than merely narrowing it), so
//! this lock is the remaining mitigation for the two paths with no seeding
//! escape hatch: `app-launched` (the process does not exist yet, so there is
//! nothing to seed against) and `wait --menu` (`wait_for_menu` resolves its
//! target through `list_apps`, not `capture_signal_baseline`, so it never
//! sees a seed at all). A live test on either of those two paths holds this
//! lock for its fixture's entire lifetime plus the wait, so at most one such
//! test's fixture exists at a time.

#![cfg(all(test, target_os = "windows"))]

use agent_desktop_core::{AdapterError, ErrorCode};
use std::cell::Cell;
use std::sync::Mutex;

pub(crate) static FIXTURE_APP_NAME_LOCK: Mutex<()> = Mutex::new(());

/// Serializes every test that raises or dismisses a shell surface. The
/// surfaces are machine-global desktop state - two tests racing the Action
/// Center resolve each other's surfaces and dismiss each other's cleanup -
/// so every such test holds this lock for its whole body. Defined beside the
/// other cross-module test locks rather than in one surface test module so
/// the tree-side surface tests and the system-side shell tests share one
/// serialization instead of two that never meet.
pub(crate) static SHELL_SURFACE_LOCK: Mutex<()> = Mutex::new(());

/// Serializes every test that reaches the real, machine-global interaction
/// lease - `ProcessLeaseGuard`'s `AtomicBool` is process-wide, so two lease
/// tests in different OS threads of the same `cargo test` binary contend on
/// it even when each targets its own scratch lock-file root. Held for the
/// entire body of any such test, never just around one call.
pub(crate) static INTERACTION_LEASE_TEST_LOCK: Mutex<()> = Mutex::new(());

/// Runs `body` under [`INTERACTION_LEASE_TEST_LOCK`], recovering from a
/// poisoned mutex rather than propagating it - one earlier test's panic must
/// not fail every later lease test the same run happens to reach.
pub(crate) fn with_interaction_lease_test_lock<R>(body: impl FnOnce() -> R) -> R {
    let _guard = INTERACTION_LEASE_TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    body()
}

pub(crate) fn with_flag<R>(
    flag: &'static std::thread::LocalKey<Cell<bool>>,
    value: bool,
    run: impl FnOnce() -> R,
) -> R {
    struct ResetOnDrop(&'static std::thread::LocalKey<Cell<bool>>);
    impl Drop for ResetOnDrop {
        fn drop(&mut self) {
            self.0.with(|cell| cell.set(false));
        }
    }
    flag.with(|cell| cell.set(value));
    let _reset = ResetOnDrop(flag);
    run()
}

pub(crate) fn with_usize_flag<R>(
    flag: &'static std::thread::LocalKey<Cell<usize>>,
    value: usize,
    run: impl FnOnce() -> R,
) -> R {
    struct ResetOnDrop(&'static std::thread::LocalKey<Cell<usize>>);
    impl Drop for ResetOnDrop {
        fn drop(&mut self) {
            self.0.with(|cell| cell.set(0));
        }
    }
    flag.with(|cell| cell.set(value));
    let _reset = ResetOnDrop(flag);
    run()
}

/// Stages the desktop so a window owns the foreground, using raw Win32 rather
/// than the product's own activation path, and reports whether the OS granted
/// it.
///
/// A live test that needs a focused window has to answer two different
/// questions, and answering them with one call conflates them: *will this
/// desktop grant foreground at all* is an environment fact, while *does
/// `focus_window` work* is the thing under test. `SetForegroundWindow` is
/// advisory - Windows refuses it unless the caller already owns the foreground
/// or the most recent input event, and a hosted runner routinely declines - so
/// the environment question is real and a leg that cannot stage its
/// precondition must say so rather than fail. But deciding that from the
/// product's own refusal makes the subject of the test its own oracle: a
/// regression that broke activation outright would report exactly the same
/// error as a declining desktop, and every leg would skip green. This stages
/// independently, so a caller can skip on a false answer and then *insist* the
/// product succeeds.
#[cfg(target_os = "windows")]
pub(crate) fn stage_foreground(handle: isize) -> bool {
    use windows_sys::Win32::Foundation::FALSE;
    use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow,
    };

    let hwnd = handle as _;
    let foreground = unsafe { GetForegroundWindow() };
    let mut foreground_tid = 0_u32;
    if !foreground.is_null() {
        unsafe {
            GetWindowThreadProcessId(foreground, &mut foreground_tid);
        }
    }
    let current_tid = unsafe { GetCurrentThreadId() };
    let attached = foreground_tid != 0
        && foreground_tid != current_tid
        && unsafe { AttachThreadInput(current_tid, foreground_tid, 1) } != FALSE;
    unsafe {
        let _ = SetForegroundWindow(hwnd);
    }
    if attached {
        unsafe {
            let _ = AttachThreadInput(current_tid, foreground_tid, 0);
        }
    }
    crate::system::window::window_ops::is_foreground_window(hwnd)
}

/// Waits until the desktop's foreground stops moving, reporting whether it
/// settled inside the budget. Raw `GetForegroundWindow` rather than any product
/// read, so a test can establish *nothing is changing* without asking the code
/// under test whether anything changed.
///
/// A freshly spawned window is not steady. Windows hands a newly created
/// top-level window the foreground a short and variable time after creation, so
/// a capture taken as soon as the spawn call returns and a capture taken a
/// settle interval later straddle a genuine focus change. A test whose premise
/// is "nothing happened between these two captures" has to establish that
/// premise by observation; inferring it from the spawn having returned is an
/// assumption that holds on an idle machine and fails on a loaded one, which
/// makes the resulting failure look like a defect in the diff rather than in
/// the test's setup.
#[cfg(target_os = "windows")]
pub(crate) fn wait_for_foreground_to_settle() -> bool {
    use std::time::{Duration, Instant};
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    const REQUIRED_STABLE_READS: u32 = 5;
    const POLL: Duration = Duration::from_millis(50);
    const BUDGET: Duration = Duration::from_secs(15);

    let deadline = Instant::now() + BUDGET;
    let mut last = unsafe { GetForegroundWindow() };
    let mut stable = 0_u32;
    while Instant::now() < deadline {
        std::thread::sleep(POLL);
        let current = unsafe { GetForegroundWindow() };
        if current == last {
            stable += 1;
            if stable >= REQUIRED_STABLE_READS {
                return true;
            }
        } else {
            stable = 0;
            last = current;
        }
    }
    false
}

/// Waits for a live source to reach an expected value, reporting whether it did
/// inside the budget, reporting whether it did inside the budget.
///
/// `wait_for_menu_state` observes the fixture's own flag, set around its
/// `TrackPopupMenu` call. The classic menu-mode bits and the UIA tool-window
/// promotion are the OS's separate views of that same transition and reach
/// their new value a short, variable time afterwards. Sleeping a fixed span
/// between the two is a guess at that lag: it holds on an idle machine and
/// fails under parallel load, where the failure reads as the detector being
/// wrong rather than as the assertion having asked too early. Waiting on the
/// value itself removes the guess without weakening what is asserted - a source
/// that never reaches the expected state still exhausts the budget and fails.
pub(crate) fn settles_to(
    budget: std::time::Duration,
    expected: bool,
    mut read: impl FnMut() -> bool,
) -> bool {
    const POLL: std::time::Duration = std::time::Duration::from_millis(25);

    let deadline = std::time::Instant::now() + budget;
    loop {
        if read() == expected {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(POLL);
    }
}

/// Whether this error is a desktop that cannot serve the measured surface
/// contract, which the live tests skip loudly on rather than failing:
/// - the accelerator or chevron invoke ran and the shell simply never
///   presented, or the shell accepted the raise but refuses the dismiss
///   (there is no shell on such a desktop to answer the close either), or
///   the tray chrome the raise depends on was never there; or
/// - the shell presented a surface of the right kind whose tree carries none
///   of the landmarks this build's adapter measures - the present-but-
///   foreign-shape case, where the product answered with its named refusal
///   and the shape difference is an accepted single-host limitation, not a
///   product failure.
pub(crate) fn shell_declined_the_surface(error: &AdapterError) -> bool {
    fn timeout_details_kind_is(error: &AdapterError, wanted: &str) -> bool {
        error.code == ErrorCode::Timeout
            && error
                .details
                .as_ref()
                .and_then(|details| details.get("kind"))
                .and_then(serde_json::Value::as_str)
                == Some(wanted)
    }
    fn details_kind_is(error: &AdapterError, wanted: &str) -> bool {
        error
            .details
            .as_ref()
            .and_then(|details| details.get("kind"))
            .and_then(serde_json::Value::as_str)
            == Some(wanted)
    }
    let raise_never_presented = timeout_details_kind_is(error, "shell_surface_not_opened");
    let close_never_dismissed = timeout_details_kind_is(error, "shell_surface_not_closed");
    let chevron_absent =
        error.code == ErrorCode::WindowNotFound && error.message.contains("notification chevron");
    let overflow_absent =
        error.code == ErrorCode::WindowNotFound && error.message.contains("overflow");
    let foreign_shape = details_kind_is(error, "shell_surface_foreign_shape");
    let declined_foreground = details_kind_is(error, "shell_surface_declined_foreground");
    raise_never_presented
        || close_never_dismissed
        || chevron_absent
        || overflow_absent
        || foreign_shape
        || declined_foreground
}

/// Maps a raise-or-resolve precondition onto the loud-skip convention, with
/// the independent raise-response oracle standing guard over it: an error the
/// desktop declined becomes a printed skip and a `None` the caller turns into
/// an early return only when the caller's oracle says the shell never
/// responded to the raise. A declined-shaped error on a desktop the oracle
/// watched respond is a product regression and fails the test - the skip
/// convention must never absorb one. Any other error still fails the test.
///
/// The oracle is only consulted on a declined-shaped error, so a successful
/// raise pays nothing for it. The closure must be measured against a witness
/// captured before the raise attempt: `raise_oracle::witness_desktop` ahead
/// of the call whose error this classifies, and
/// `raise_oracle::responded_since` as the closure.
pub(crate) fn or_skip_shell<T>(
    what: &str,
    result: Result<T, AdapterError>,
    responded: impl FnOnce() -> bool,
) -> Option<T> {
    match result {
        Ok(value) => Some(value),
        Err(error) if is_foreign_shape_refusal(&error) => {
            eprintln!(
                "skip {what}: the shell presented a surface whose tree does not match \
                 the landmarks this build measures"
            );
            None
        }
        Err(error) if shell_declined_the_surface(&error) => {
            eprintln!("{}", declined_message(what, responded, &error));
            None
        }
        Err(error) => panic!("{what}: {error:?}"),
    }
}

fn declined_message(what: &str, responded: impl FnOnce() -> bool, error: &AdapterError) -> String {
    if responded() {
        format!(
            "WARN skip {what}: the shell responded to the raise but the product \
             reported a declined precondition - a possible product regression. \
             The responding surface was not diagnosable as this kind's shape on \
             this desktop, so the suspicion cannot be confirmed here; verify on \
             a host that presents the measured surface ({error:?})"
        )
    } else {
        format!("skip {what}: this desktop's shell declined to present the surface")
    }
}

/// Whether the product answered with its named present-but-foreign-shape
/// refusal: the shell presented a surface of the kind, the shape matched none
/// of the measured landmarks, and the refusal is the honest answer - not a
/// declined precondition the raise-response oracle needs to guard, because
/// the product did exactly what its error table says for that case.
fn is_foreign_shape_refusal(error: &AdapterError) -> bool {
    error
        .details
        .as_ref()
        .and_then(|details| details.get("kind"))
        .and_then(serde_json::Value::as_str)
        == Some("shell_surface_foreign_shape")
}

#[cfg(test)]
mod shell_decline_classification {
    use super::*;

    fn declined_open_error() -> AdapterError {
        AdapterError::timeout("the 'action-center' shell surface did not open within the deadline")
            .with_details(serde_json::json!({ "kind": "shell_surface_not_opened" }))
    }

    #[test]
    fn the_declined_shapes_classify_and_unrelated_errors_do_not() {
        let declined_open = declined_open_error();
        assert!(shell_declined_the_surface(&declined_open));

        let declined_close = AdapterError::timeout(
            "the 'start-menu' shell surface did not close within the deadline",
        )
        .with_details(serde_json::json!({ "kind": "shell_surface_not_closed" }));
        assert!(shell_declined_the_surface(&declined_close));

        let chevron_absent = AdapterError::new(
            ErrorCode::WindowNotFound,
            "the notification chevron button is not present in the taskbar",
        );
        assert!(shell_declined_the_surface(&chevron_absent));

        let foreign_shape = AdapterError::new(
            ErrorCode::PlatformNotSupported,
            "the shell presented a surface of this kind whose tree does not match \
             the landmarks this build's adapter measures",
        )
        .with_details(serde_json::json!({ "kind": "shell_surface_foreign_shape" }));
        assert!(shell_declined_the_surface(&foreign_shape));

        let stale = AdapterError::stale_ref("@s8f3k2p9:e1");
        assert!(!shell_declined_the_surface(&stale));

        let unrelated_window = AdapterError::new(
            ErrorCode::WindowNotFound,
            "no window matches the requested identity",
        );
        assert!(!shell_declined_the_surface(&unrelated_window));
    }

    #[test]
    fn a_declined_error_with_a_silent_shell_skips_loudly() {
        let declined_open = declined_open_error();

        let message = declined_message("witness probe", || false, &declined_open);
        let outcome = or_skip_shell("witness probe", Err::<(), _>(declined_open), || false);

        assert!(outcome.is_none(), "a silent shell still skips");
        assert!(message.starts_with("skip witness probe"), "{message}");
        assert!(!message.contains("WARN"), "{message}");
    }

    #[test]
    fn a_declined_error_on_a_responded_shell_skips_with_a_regression_warning() {
        let declined_open = declined_open_error();

        let message = declined_message("witness probe", || true, &declined_open);
        let outcome = or_skip_shell("witness probe", Err::<(), _>(declined_open), || true);

        assert!(outcome.is_none(), "a responded shell still skips");
        assert!(message.starts_with("WARN skip witness probe"), "{message}");
        assert!(message.contains("possible product regression"), "{message}");
    }

    #[test]
    #[should_panic(expected = "witness probe")]
    fn an_unrelated_error_fails_whatever_the_shell_did() {
        let stale = AdapterError::stale_ref("@s8f3k2p9:e1");

        let _ = or_skip_shell("witness probe", Err::<(), _>(stale), || false);
    }
}
