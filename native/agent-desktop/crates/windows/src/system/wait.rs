use std::time::Duration;

use agent_desktop_core::{
    AdapterError, Deadline, DeliverySemantics, ErrorCode, ProcessId, ProcessIdentity,
};

use super::menu::menu_state::menu_is_open;
use super::process_identity;

const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// How long a predicate error waits on the target's process handle for an exit
/// to land before the error is reported as the target's own. A window that
/// stopped pumping because its process is closing is observed before the
/// process object is signaled, so a single liveness check cannot tell that
/// teardown from a target that is merely unresponsive; the handle wait can.
const EXIT_CONFIRMATION_SLICE: Duration = Duration::from_millis(1_000);

/// Polls the [`menu_is_open`] predicate until the target process's
/// menu-open state equals `open`, then returns `Ok(())`.
///
/// A deliberate structural port of `crates/macos/src/system/wait.rs`: the
/// process identity is re-verified before the first predicate read on every
/// iteration and a second time immediately before success is declared - the
/// macOS double-check that closes the window where the target dies between
/// the read and the return. The deadline is consulted only after a mismatch,
/// so the predicate is evaluated at least once **once this loop is reached**,
/// and an already-closed menu satisfies a wait-for-closed on that first read.
///
/// That guarantee is this function's, not the command's, and the difference
/// is observable: the caller resolves the target application before calling
/// here, and on a budget smaller than that resolution costs the command
/// refuses with the generic deadline error without ever reaching this loop.
/// A timeout that must survive application resolution has to be larger than
/// resolution costs; this loop cannot rescue a budget that is already spent
/// when it is handed one.
///
/// Core makes exactly one call here and owns no retry of its own
/// (`crates/core/src/commands/wait.rs:118-123`), so every condition this
/// loop can absorb - the 50ms poll interval, the identity re-checks, and a
/// predicate read that itself times out mid-poll - is absorbed here rather
/// than propagated raw: a `Timeout` from the predicate falls through to this
/// loop's own deadline check so the direction-specific message below still
/// applies, instead of surfacing the predicate's own undecorated timeout.
///
/// Diverges from macOS's `AppUnresponsive` mapping for an identity mismatch:
/// this method reports the exited-or-recycled target as `StaleRef`, the code
/// this crate already uses for a resolved reference that no longer matches
/// live state, rather than the transient-condition code macOS reuses there.
///
/// The same precedence covers a non-`Timeout` predicate error: `menu_state`
/// reports a target that vanished mid-read as a transient `AppUnresponsive`,
/// and a target mid-teardown reports it while its process object is not yet
/// signaled. So before that error leaves the method the loop re-checks
/// liveness and then waits on the target's process handle, capped by both
/// [`EXIT_CONFIRMATION_SLICE`] and the caller's deadline: a target that exits
/// inside that window surfaces as `StaleRef`, while a live-but-unresponsive
/// target still propagates the predicate's own error unchanged once the
/// window passes.
pub(crate) fn wait_for_menu(
    process: ProcessIdentity,
    open: bool,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    let mut state_never_read = true;
    loop {
        verify_process_alive(&process)?;
        match evaluate_menu_state(process.pid, deadline) {
            Ok(state) if state == open => {
                verify_process_alive(&process)?;
                return Ok(());
            }
            Ok(_) => state_never_read = false,
            Err(error) if error.code == ErrorCode::Timeout => {}
            Err(error) => return Err(settle_predicate_error(&process, error, deadline)),
        }
        if deadline.is_expired() {
            return Err(deadline
                .timeout_error()
                .with_platform_detail(expiry_detail(open, state_never_read)));
        }
        let pause = deadline
            .remaining_slice(POLL_INTERVAL)
            .map_err(|error| error.with_platform_detail(direction_message(open)))?;
        std::thread::sleep(pause);
    }
}

fn direction_message(open: bool) -> &'static str {
    if open {
        "No menu opened before the deadline"
    } else {
        "Menu did not close before the deadline"
    }
}

/// Separates "the menu never reached the state" from "the menu state was
/// never read at all".
///
/// Every poll that times out is absorbed so a slow read does not end the
/// wait early, which is right - but if *no* poll ever returned an answer,
/// the deadline message describes a menu this code never actually observed.
/// Saying so points at the provider rather than at the menu.
fn expiry_detail(open: bool, state_never_read: bool) -> String {
    let direction = direction_message(open);
    if state_never_read {
        format!("{direction}; no poll read the menu state before the deadline")
    } else {
        direction.to_string()
    }
}

/// Routes every predicate read through one call site so a test can count
/// polls without changing what production code executes.
fn evaluate_menu_state(pid: ProcessId, deadline: Deadline) -> Result<bool, AdapterError> {
    #[cfg(test)]
    poll_calls::record();
    #[cfg(test)]
    if let Some(error) = forced_predicate_error::take() {
        return Err(error);
    }
    menu_is_open(pid, deadline)
}

/// Decides what a non-`Timeout` predicate error means once it has been read: a
/// target that is gone, or that exits within the bounded confirmation window on
/// its process handle, is `StaleRef`; a target still alive after the window
/// keeps the predicate's own error. The window is capped by the caller's
/// deadline, so confirmation never extends the wait.
fn settle_predicate_error(
    process: &ProcessIdentity,
    error: AdapterError,
    deadline: Deadline,
) -> AdapterError {
    if let Err(gone) = verify_process_alive(process) {
        return gone;
    }
    let window = deadline.remaining().min(EXIT_CONFIRMATION_SLICE);
    if exited_within(process, window) {
        return stale_process_error(process);
    }
    error
}

fn exited_within(process: &ProcessIdentity, window: Duration) -> bool {
    #[cfg(test)]
    if forced_process_death::take() {
        return true;
    }
    process_identity::wait_for_exit(process.pid, window)
}

fn verify_process_alive(process: &ProcessIdentity) -> Result<(), AdapterError> {
    #[cfg(test)]
    if forced_process_death::take() {
        return Err(stale_process_error(process));
    }
    if process_identity::matches_instance(process.pid, &process.instance)?
        && process_identity::process_is_running(process.pid)
    {
        Ok(())
    } else {
        Err(stale_process_error(process))
    }
}

/// A target that died mid-wait is a fully understood outcome at the moment
/// this error is built, so it carries the disposition and recovery an agent
/// needs rather than defaulting to `unknown`. Nothing was delivered - the wait
/// only ever observed - and retrying the same wait against the same process
/// instance can never succeed, because that instance is gone for good; the
/// caller has to resolve the application again. The wording is
/// process-specific rather than borrowed from the ref-oriented core helper,
/// which tells the caller to re-run a snapshot for a fresh ref - advice this
/// surface has no refs for.
fn stale_process_error(process: &ProcessIdentity) -> AdapterError {
    AdapterError::new(
        ErrorCode::StaleRef,
        "Target process instance is no longer running",
    )
    .with_suggestion(concat!(
        "The application exited during the wait. Re-resolve it with list-apps ",
        "and retry against the new process instance, or treat its exit as the outcome.",
    ))
    .with_disposition(DeliverySemantics::not_delivered())
    .with_details(serde_json::json!({
        "pid": u32::from(process.pid),
        "process_instance": process.instance,
    }))
}

#[cfg(test)]
pub(super) mod poll_calls {
    use std::cell::Cell;

    thread_local! {
        static COUNT: Cell<usize> = const { Cell::new(0) };
    }

    pub(super) fn record() {
        crate::system::fixture::call_counter::record(&COUNT);
    }

    pub(super) fn take() -> usize {
        crate::system::fixture::call_counter::take(&COUNT)
    }
}

/// Arms a predicate error for exactly one future [`evaluate_menu_state`]
/// call, so a test can prove the loop's non-`Timeout` propagation without a
/// live GUI fixture: the forced error is consumed on the first read that
/// finds it armed, leaving every later read on the same thread to fall
/// through to the real predicate.
#[cfg(test)]
pub(super) mod forced_predicate_error {
    use std::cell::RefCell;

    use agent_desktop_core::AdapterError;

    thread_local! {
        static FORCED: RefCell<Option<AdapterError>> = const { RefCell::new(None) };
    }

    pub(super) fn arm(error: AdapterError) {
        FORCED.with(|cell| *cell.borrow_mut() = Some(error));
    }

    pub(super) fn take() -> Option<AdapterError> {
        FORCED.with(|cell| cell.borrow_mut().take())
    }
}

/// Forces the process-liveness consultations to report the target gone after a
/// chosen number of successful ones, so a test can stage the race where a
/// process exits between the loop's pre-read liveness check and the predicate
/// read, or only after the in-arm re-check while its exit confirmation is
/// still pending - `forced_predicate_error` supplies the intervening
/// evaluation failure - without racing a real termination. `verify_process_alive`
/// and `exited_within` each count as one consultation.
#[cfg(test)]
pub(super) mod forced_process_death {
    use std::cell::Cell;

    thread_local! {
        static SKIPS_REMAINING: Cell<Option<usize>> = const { Cell::new(None) };
    }

    pub(super) fn arm_after(skips: usize) {
        SKIPS_REMAINING.with(|cell| cell.set(Some(skips)));
    }

    pub(super) fn take() -> bool {
        SKIPS_REMAINING.with(|cell| match cell.get() {
            None => false,
            Some(0) => {
                cell.set(None);
                true
            }
            Some(remaining) => {
                cell.set(Some(remaining - 1));
                false
            }
        })
    }
}

#[cfg(test)]
#[path = "wait_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "wait_menu_command_live_tests.rs"]
mod menu_command_live_tests;
