use std::time::{Duration, Instant};

use agent_desktop_core::{AdapterError, Deadline, ErrorCode, ProcessId};

use super::super::{
    EXIT_CONFIRMATION_SLICE, forced_predicate_error, forced_process_death, settle_predicate_error,
    wait_for_menu,
};
use super::identity_for;

fn unresponsive(message: &str) -> AdapterError {
    AdapterError::new(ErrorCode::AppUnresponsive, message)
}

/// Stages the flaky teardown without racing a real termination: a window that
/// stopped pumping reports `AppUnresponsive` while the process object is still
/// unsignaled, so the loop-top check and the in-arm liveness re-check both read
/// the target as alive, and only the exit confirmation on the process handle,
/// the third liveness consultation, sees it gone. A regression back to a single
/// one-shot liveness check answers `AppUnresponsive` here and never consults
/// that third check.
#[test]
fn a_target_that_exits_after_the_liveness_rechecks_still_surfaces_as_stale_ref() {
    let identity = identity_for(ProcessId::from(std::process::id()));
    forced_process_death::arm_after(2);
    forced_predicate_error::arm(unresponsive("menu_probe_window_not_pumping"));

    let error = wait_for_menu(identity, true, Deadline::after(10_000).expect("deadline"))
        .expect_err("a target that exits during teardown must not report a satisfied wait");

    assert_eq!(error.code, ErrorCode::StaleRef, "{error:?}");
}

/// The confirmation window is capped by the caller's deadline, so an already
/// spent budget cannot be stretched by the confirmation slice.
#[test]
fn the_exit_confirmation_never_outlasts_a_spent_deadline() {
    let identity = identity_for(ProcessId::from(std::process::id()));
    let deadline = Deadline::after(1).expect("deadline");
    std::thread::sleep(Duration::from_millis(20));
    let started = Instant::now();

    let error = settle_predicate_error(&identity, unresponsive("still alive"), deadline);

    assert_eq!(error.code, ErrorCode::AppUnresponsive, "{error:?}");
    assert!(
        started.elapsed() < EXIT_CONFIRMATION_SLICE / 2,
        "a spent deadline must not wait out the {EXIT_CONFIRMATION_SLICE:?} confirmation slice, \
         elapsed {:?}",
        started.elapsed()
    );
}
