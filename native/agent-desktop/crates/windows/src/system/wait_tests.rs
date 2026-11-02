//! Windows-only: drives a real `MenuFixture` through `wait_for_menu` in both
//! directions, proving the poll loop against live process and menu state
//! rather than a hand-rolled predicate stub.
//!
//! Every `MenuFixture` here is a re-exec'd child of this same test binary, so
//! it shares its process image name with every other such fixture in this
//! crate. Each test below holds `test_support::FIXTURE_APP_NAME_LOCK` for its
//! fixture's entire lifetime so it cannot coexist with another lock-holding
//! test's fixture and defeat that test's `list_apps`-by-name resolution.
//!
//! `open_true_returns_ok_once_the_fixtures_menu_opens_shortly_after_the_wait_starts`
//! additionally takes `fixture_window::on_screen_stage` even though it
//! stages nothing itself: `menu_state_tests.rs`'s
//! `menu_is_open_is_isolated_to_the_queried_process` forces cross-thread
//! input attachment (`AttachThreadInput`/`SetForegroundWindow`) elsewhere in
//! this crate, which can stall an unrelated thread's message pump, and this
//! test's fixture dispatching a posted window message within its own budget
//! is exactly what that stalls. Taking the stage lock here is the same
//! "guards screen state, not only screen real estate" reasoning
//! `window_activate_tests.rs`'s focus tests documents. Where a test needs
//! both locks, `FIXTURE_APP_NAME_LOCK` is always acquired first and
//! `on_screen_stage` second.
//!
//! `a_menu_that_never_transitions_times_out_with_direction_specific_platform_detail`
//! also takes the stage lock for the same reason `menu_state_tests.rs`'s
//! `uia_source_detects_the_fixtures_context_menu_open_and_closed` and its
//! siblings do: its `never_closes` fixture holds a menu open across an
//! assertion window, and any other window gaining OS foreground during that
//! window sends the menu owner `WM_CANCELMODE`, dismissing it and turning
//! the expected timeout into a false "closed".
#![cfg(target_os = "windows")]

use super::*;

use std::sync::mpsc::channel;
use std::thread;
use std::time::{Duration, Instant};

use crate::system::fixture::test_support::FIXTURE_APP_NAME_LOCK;
use crate::tree::fixture::bootstrap;
use crate::tree::fixture::fixture_menu::MenuFixture;

/// A generous budget for the fixture's own child process to dispatch a
/// posted window message and for the adapter's poll loop to observe the
/// resulting menu-mode transition. Under heavy concurrent test load this
/// crate's fixtures compete for CPU with dozens of other re-exec'd child
/// processes, so a tight budget here flakes on nothing but scheduling delay,
/// the same reasoning `READY_TIMEOUT` (30s) already applies to fixture
/// startup.
const STATE_TIMEOUT: Duration = Duration::from_secs(15);
const SETTLE: Duration = Duration::from_millis(250);
const OPEN_AFTER: Duration = Duration::from_millis(300);
const RECV_TIMEOUT: Duration = Duration::from_secs(20);
const TRANSITION_DEADLINE_MS: u64 = 15_000;

fn deadline(timeout_ms: u64) -> Deadline {
    Deadline::after(timeout_ms).expect("bounded deadline")
}

fn identity_for(pid: ProcessId) -> ProcessIdentity {
    crate::system::fixture::live_identity::live_process_identity(pid)
}

#[test]
fn open_true_returns_ok_once_the_fixtures_menu_opens_shortly_after_the_wait_starts() {
    bootstrap();
    let _app_name_scope = FIXTURE_APP_NAME_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let fixture = MenuFixture::spawn().expect("the menu fixture starts");
    let identity = identity_for(ProcessId::from(fixture.process_id()));

    let (sender, receiver) = channel();
    thread::spawn(move || {
        let result = wait_for_menu(identity, true, deadline(TRANSITION_DEADLINE_MS));
        let _ = sender.send(result);
    });

    thread::sleep(OPEN_AFTER);
    fixture.open_context_menu();
    assert!(fixture.wait_for_menu_state(true, STATE_TIMEOUT));

    let result = receiver
        .recv_timeout(RECV_TIMEOUT)
        .expect("wait_for_menu completed");

    assert!(
        result.is_ok(),
        "expected Ok once the menu opened, got {result:?}"
    );
    assert!(
        fixture.menu_is_up(),
        "the fixture's own independently-tracked state must confirm the menu is open"
    );

    fixture.dismiss_context_menu();
    assert!(fixture.wait_for_menu_state(false, STATE_TIMEOUT));
}

#[test]
fn open_false_waits_and_returns_ok_once_the_already_open_menu_is_dismissed() {
    bootstrap();
    let _app_name_scope = FIXTURE_APP_NAME_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let fixture = MenuFixture::spawn().expect("the menu fixture starts");
    fixture.open_context_menu();
    assert!(fixture.wait_for_menu_state(true, STATE_TIMEOUT));
    thread::sleep(SETTLE);
    let identity = identity_for(ProcessId::from(fixture.process_id()));

    let (sender, receiver) = channel();
    thread::spawn(move || {
        let result = wait_for_menu(identity, false, deadline(TRANSITION_DEADLINE_MS));
        let _ = sender.send(result);
    });

    thread::sleep(OPEN_AFTER);
    fixture.dismiss_context_menu();

    let result = receiver
        .recv_timeout(RECV_TIMEOUT)
        .expect("wait_for_menu completed");

    assert!(
        result.is_ok(),
        "expected Ok once the fixture dismissed its menu, got {result:?}"
    );
    assert!(fixture.wait_for_menu_state(false, STATE_TIMEOUT));
}

/// Uses a poll-count assertion rather than an elapsed-time one so the
/// property holds regardless of host speed: the predicate is read exactly
/// once when the requested state already holds, proving the deadline is
/// consulted only after that first read rather than gating it.
#[test]
fn already_in_the_requested_state_returns_immediately_reading_the_predicate_once() {
    bootstrap();
    let _app_name_scope = FIXTURE_APP_NAME_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let fixture = MenuFixture::spawn().expect("the menu fixture starts");
    let identity = identity_for(ProcessId::from(fixture.process_id()));
    poll_calls::take();

    let result = wait_for_menu(identity, false, deadline(5_000));

    assert!(
        result.is_ok(),
        "the menu is already closed, so the wait must succeed without polling twice"
    );
    assert_eq!(
        poll_calls::take(),
        1,
        "the predicate must be read exactly once when the state already matches"
    );
}

#[test]
fn a_menu_that_never_transitions_times_out_with_direction_specific_platform_detail() {
    bootstrap();
    let _app_name_scope = FIXTURE_APP_NAME_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let never_opens = MenuFixture::spawn().expect("the menu fixture starts");
    let open_identity = identity_for(ProcessId::from(never_opens.process_id()));

    let open_error = wait_for_menu(open_identity, true, deadline(400))
        .expect_err("a menu that never opens must time out");

    let never_closes = MenuFixture::spawn().expect("the menu fixture starts");
    never_closes.open_context_menu();
    assert!(never_closes.wait_for_menu_state(true, STATE_TIMEOUT));
    thread::sleep(SETTLE);
    let close_identity = identity_for(ProcessId::from(never_closes.process_id()));

    let close_error = wait_for_menu(close_identity, false, deadline(400))
        .expect_err("a menu that never closes must time out");
    never_closes.dismiss_context_menu();
    assert!(never_closes.wait_for_menu_state(false, STATE_TIMEOUT));

    assert_eq!(open_error.code, ErrorCode::Timeout);
    assert_eq!(close_error.code, ErrorCode::Timeout);
    assert_eq!(
        open_error.platform_detail.as_deref(),
        Some("No menu opened before the deadline")
    );
    assert_eq!(
        close_error.platform_detail.as_deref(),
        Some("Menu did not close before the deadline")
    );
}

/// The pid-recycling half of the identity discipline - a dead process whose
/// pid is reused by an unrelated live process before the next poll - cannot
/// be staged deterministically on demand, the same limitation
/// `menu_is_open_is_isolated_to_the_queried_process` in `menu_state_tests.rs`
/// documents for its own isolation property. What this test proves
/// deterministically is the half that a real termination does exercise: the
/// process-alive re-check the loop runs before every predicate read catches
/// the death and reports `StaleRef`, never a satisfied wait and never a
/// generic timeout.
///
/// The target is a windowless child ended with `TerminateProcess`, whose exit
/// is immediate. A GUI fixture closed through `WM_CLOSE` exits on its own
/// schedule, which on a loaded runner can outlast the exit confirmation slice
/// and turn the teardown into a legitimate `AppUnresponsive`; that
/// confirmation is covered with a staged clock in
/// `wait_exit_confirmation_tests.rs`.
#[test]
fn a_target_that_exits_mid_wait_returns_stale_ref_not_a_satisfied_wait_or_a_timeout() {
    let mut target = std::process::Command::new("ping")
        .args(["-n", "120", "127.0.0.1"])
        .stdout(std::process::Stdio::null())
        .spawn()
        .expect("the windowless target starts");
    let identity = identity_for(ProcessId::from(target.id()));

    let (sender, receiver) = channel();
    thread::spawn(move || {
        let result = wait_for_menu(identity, true, deadline(10_000));
        let _ = sender.send(result);
    });

    thread::sleep(OPEN_AFTER);
    target.kill().expect("the target is terminated");
    target.wait().expect("the target is reaped");

    let result = receiver
        .recv_timeout(RECV_TIMEOUT)
        .expect("wait_for_menu completed");
    let error = result.expect_err("a terminated target must not report a satisfied wait");

    assert_eq!(error.code, ErrorCode::StaleRef, "{error:?}");
}

/// A loose upper bound derived from the interval, not a timing literal
///: a spinning loop that ignored `remaining_slice` would blow past it
/// by orders of magnitude inside the same wall-clock budget.
const SPIN_GUARD_MAX_POLLS: usize = 40;

#[test]
fn the_poll_loop_does_not_spin_over_a_fixed_timeout() {
    bootstrap();
    let _app_name_scope = FIXTURE_APP_NAME_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let fixture = MenuFixture::spawn().expect("the menu fixture starts");
    let identity = identity_for(ProcessId::from(fixture.process_id()));
    poll_calls::take();

    let result = wait_for_menu(identity, true, deadline(500));

    result.expect_err("a menu that never opens must time out rather than spin forever");
    let polls = poll_calls::take();
    assert!(
        polls <= SPIN_GUARD_MAX_POLLS,
        "poll count {polls} over a 500ms wait suggests the loop is not sleeping between reads"
    );
}

/// A target that dies mid-wait must carry the disposition and recovery an
/// agent acts on. `DeliverySemantics` defaults to unknown/unknown, so an
/// error built without an explicit disposition tells a caller nothing about
/// whether the wait delivered anything or whether retrying is safe - and this
/// failure is completely understood at the point it is constructed. The
/// project's own envelope contract says a consumer may read `recovery` only
/// when the retry disposition is `safe`, which a defaulted `unknown` never is.
#[test]
fn a_target_that_died_mid_wait_reports_a_disposition_and_a_recovery() {
    let error = stale_process_error(&ProcessIdentity::new(ProcessId::from(4321u32), "gone"));

    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(
        error.disposition.delivery(),
        agent_desktop_core::DeliveryDisposition::NotDelivered,
        "a wait only observes, so a dead target delivered nothing"
    );
    assert!(
        error.suggestion.is_some(),
        "a dead target is a recoverable condition and must say how to recover"
    );
    let suggestion = error.suggestion.unwrap_or_default();
    assert!(
        !suggestion.contains("  "),
        "the suggestion is delivered verbatim in the JSON envelope, so a wrapped string          literal must not leave a run of indentation inside it, got {suggestion:?}"
    );
    assert!(
        !suggestion.contains("snapshot") && !suggestion.contains("ref"),
        "the recovery must be process-oriented; this surface has no refs or \
         snapshots to refresh, got {suggestion}"
    );
}

/// The predicate's own `Timeout` is deliberately absorbed and retried (the
/// loop's deadline check is the thing that should end that direction), but
/// every other error is a decided answer and must return on the first
/// occurrence. `forced_predicate_error` stands in for a real non-pumping
/// target the way `window_ops.rs`'s `force_window_not_found` stands in for a
/// real identity race elsewhere in this crate - both let a test pin the
/// loop's error-handling branch without staging the live condition. A
/// regression that widened the absorbed set to include this code, or that
/// kept retrying after the first non-`Timeout` error, would drive
/// `poll_calls` past one and the elapsed time toward the 10s deadline; this
/// test targets the current process, so no fixture or lock is needed.
#[test]
fn a_non_timeout_predicate_error_propagates_on_the_first_poll_without_spinning_to_the_deadline() {
    let pid = ProcessId::from(std::process::id());
    let token = process_identity::token_for_pid(pid)
        .expect("token read for this process")
        .expect("this process has a live process instance token");
    let identity = ProcessIdentity::new(pid, token);
    poll_calls::take();
    forced_predicate_error::arm(AdapterError::new(
        ErrorCode::AppUnresponsive,
        "forced test predicate failure",
    ));

    let started = Instant::now();
    let result = wait_for_menu(identity, true, Deadline::after(10_000).expect("deadline"));

    let error = result.expect_err("a non-Timeout predicate error must propagate, not be absorbed");
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert_eq!(
        poll_calls::take(),
        1,
        "the loop must return on the first predicate read rather than retrying"
    );
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "a swallowed error would spin toward the 10s deadline instead of returning immediately, \
         elapsed {:?}",
        started.elapsed()
    );
}

/// Pins the terminal error arm's mapping in both directions without racing a
/// real process. `forced_predicate_error` supplies the `AppUnresponsive` that
/// `menu_state` returns for a target that vanished mid-read, and
/// `forced_process_death` makes the loop's own liveness re-check observe that
/// death after the pre-read check already passed. A regression that
/// propagated the predicate error without re-checking liveness would answer
/// the first case with the transient `AppUnresponsive` instead of the
/// contract's `StaleRef` and fail here, while the second case proves the same
/// error still propagates untouched when the target is alive.
#[test]
fn an_evaluation_error_surfaces_as_stale_ref_when_the_target_is_gone_and_unchanged_when_it_is_alive()
 {
    let pid = ProcessId::from(std::process::id());
    let token = process_identity::token_for_pid(pid)
        .expect("token read for this process")
        .expect("this process has a live process instance token");
    let identity = ProcessIdentity::new(pid, token);

    forced_predicate_error::arm(AdapterError::new(
        ErrorCode::AppUnresponsive,
        "The target process could not be found",
    ));
    let alive = wait_for_menu(
        identity.clone(),
        true,
        Deadline::after(10_000).expect("deadline"),
    )
    .expect_err("a non-Timeout predicate error must propagate");
    assert_eq!(
        alive.code,
        ErrorCode::AppUnresponsive,
        "a live-but-unresponsive target must keep the predicate's own error"
    );
    assert_eq!(
        alive.message, "The target process could not be found",
        "the original error must propagate unchanged"
    );

    forced_process_death::arm_after(1);
    forced_predicate_error::arm(AdapterError::new(
        ErrorCode::AppUnresponsive,
        "The target process could not be found",
    ));
    let gone = wait_for_menu(identity, true, Deadline::after(10_000).expect("deadline"))
        .expect_err("a target that exited mid-read must not report a satisfied wait");
    assert_eq!(
        gone.code,
        ErrorCode::StaleRef,
        "an evaluation error raised while the target is gone must surface as StaleRef"
    );
}

#[path = "wait_expiry_detail_tests.rs"]
mod expiry_detail_tests;

#[path = "wait_exit_confirmation_tests.rs"]
mod exit_confirmation_tests;
