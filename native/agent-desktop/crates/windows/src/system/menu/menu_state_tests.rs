//! Windows-only: drives real classic Win32 menus (`MenuFixture`) and a
//! non-pumping window (`StalledFixture`) against both measured sources
//! (A23-1, A23-11) and their union. A23-10 grounds the no-GUI-thread and
//! nonexistent-pid cases.
//!
//! Every `MenuFixture` here is a re-exec'd child of this same test binary, so
//! it shares its process image name with every other such fixture in this
//! crate. Each test that spawns one holds `test_support::FIXTURE_APP_NAME_LOCK`
//! for its fixture's entire lifetime so it cannot coexist with another
//! lock-holding test's fixture and defeat that test's `list_apps`-by-name
//! resolution.
//!
//! `menu_is_open_is_isolated_to_the_queried_process` additionally forces OS
//! foreground onto its fixture via `raise_handle`
//! (`AttachThreadInput`/`SetForegroundWindow`), which can stall an unrelated
//! thread's message pump while the input queues are attached. It therefore
//! also holds `fixture_window::on_screen_stage` for as long as it forces
//! foreground, the same DESKTOP/FOREGROUND-state guard
//! `window_activate_tests.rs`'s focus tests and `key_dispatch_tests.rs`
//! already take. Where a test needs both locks, `FIXTURE_APP_NAME_LOCK` is
//! always acquired first and `on_screen_stage` second - taking them in the
//! opposite order anywhere in this crate would deadlock the suite against a
//! test that acquires them the mandated way.
//!
//! Win32 menu mode is canceled by activation change: any other window
//! gaining OS foreground sends the menu's owner `WM_CANCELMODE` and the
//! fixture's context menu dismisses out from under whichever test opened it.
//! `uia_source_detects_the_fixtures_context_menu_open_and_closed` and
//! `menu_is_open_reports_the_fixtures_transition_in_both_directions` each
//! hold a menu open across an assertion window, so each also takes
//! `fixture_window::on_screen_stage` for that span even though none of them
//! stages anything itself - the same "guards screen state, not only screen
//! real estate" reasoning `window_activate_tests.rs`'s focus tests
//! documents. The two directions that never expect a transition
//! (`a_pid_with_no_gui_threads_reports_closed_rather_than_erroring` and the
//! never-*opens* half of `wait_tests.rs`'s timeout test) are unaffected by a
//! foreign dismissal and do not need the lock.
#![cfg(target_os = "windows")]

use super::*;
use crate::system::fixture::test_support::settles_to;

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::system::fixture::test_support::FIXTURE_APP_NAME_LOCK;
use crate::tree::fixture::fixture_menu::MenuFixture;
use crate::tree::fixture::{StalledFixture, bootstrap};

const STATE_TIMEOUT: Duration = Duration::from_secs(5);

use crate::system::fixture::test_time::deadline;

/// Whether the OS actually granted the fixture window the foreground.
///
/// `SetForegroundWindow` is advisory: Windows refuses it unless the calling
/// process already owns the foreground or owns the most recent input event,
/// and a hosted CI session routinely declines. That matters here because
/// `TrackPopupMenu` on a window that is not foreground has its popup
/// dismissed immediately, so the fixture reports that it *called* the API
/// while no menu is on screen for the predicate to find. Asserting through an
/// ungranted foreground tests the OS's focus policy rather than the predicate,
/// so a leg that cannot stage its precondition says so and stops.
fn foreground_granted(handle: isize) -> bool {
    crate::system::window::window_ops::is_foreground_window(handle as _)
}

/// Forces `handle` to the OS foreground window even from a background
/// process, via the same raw-Win32 stage every live test needing a focused
/// window uses.
fn raise_handle(handle: isize) {
    let _ = crate::system::fixture::test_support::stage_foreground(handle);
}

#[test]
fn an_already_expired_deadline_returns_timeout_before_any_native_work() {
    thread_snapshot_calls::take();
    let expired = Deadline::after(0).expect("a zero-timeout deadline is constructible");

    let error =
        menu_is_open(ProcessId::from(std::process::id()), expired).expect_err("must refuse");

    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(
        thread_snapshot_calls::take(),
        0,
        "an already-expired deadline must perform no thread enumeration"
    );
}

#[test]
fn a_pid_with_no_gui_threads_reports_closed_rather_than_erroring() {
    let mut child = Command::new("cmd.exe")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("a bare console process starts");
    let pid = ProcessId::from(child.id());

    let open = menu_is_open(pid, deadline(10_000))
        .expect("a console-only process must not error the predicate");

    assert!(!open, "a process with no GUI thread has no menu open");

    let _ = child.kill();
    let _ = child.wait();
}

/// Windows process ids are always multiples of 4 (0 is the Idle process, 4
/// is the System process), so an odd id is never assigned to a real process
/// on any Windows build - a deterministic structural fact, not a race

#[test]
fn uia_source_detects_the_fixtures_context_menu_open_and_closed() {
    bootstrap();
    let _app_name_scope = FIXTURE_APP_NAME_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let fixture = MenuFixture::spawn().expect("the menu fixture starts");
    let pid = ProcessId::from(fixture.process_id());

    assert!(
        !uia_menu_reachable(pid, deadline(10_000)).expect("uia probe reads the fixture"),
        "no root-level tool window with a reachable menu family exists before any command is sent"
    );
    let reachable =
        || uia_menu_reachable(pid, deadline(10_000)).expect("uia probe reads the fixture");

    fixture.open_context_menu();
    assert!(fixture.wait_for_menu_state(true, STATE_TIMEOUT));
    assert!(
        settles_to(STATE_TIMEOUT, true, reachable),
        "A23-11: an open Win32 context menu promotes a root-level tool window with a reachable \
         menu family"
    );

    fixture.dismiss_context_menu();
    assert!(fixture.wait_for_menu_state(false, STATE_TIMEOUT));
    assert!(
        settles_to(STATE_TIMEOUT, false, reachable),
        "the promoted tool window must be gone once the fixture's menu is dismissed"
    );
}

#[test]
fn menu_is_open_reports_the_fixtures_transition_in_both_directions() {
    bootstrap();
    let _app_name_scope = FIXTURE_APP_NAME_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let fixture = MenuFixture::spawn().expect("the menu fixture starts");
    let pid = ProcessId::from(fixture.process_id());

    assert!(!menu_is_open(pid, deadline(10_000)).expect("predicate reads the fixture"));

    fixture.open_context_menu();
    assert!(fixture.wait_for_menu_state(true, STATE_TIMEOUT));
    assert!(settles_to(STATE_TIMEOUT, true, || menu_is_open(
        pid,
        deadline(10_000)
    )
    .expect("predicate reads the fixture")));

    fixture.dismiss_context_menu();
    assert!(fixture.wait_for_menu_state(false, STATE_TIMEOUT));
    assert!(settles_to(STATE_TIMEOUT, false, || menu_is_open(
        pid,
        deadline(10_000)
    )
    .expect("predicate reads the fixture")));
}

/// The isolation property: another process's open menu must never leak into
/// the pid actually being queried. `raise_handle` deterministically makes
/// the fixture the OS foreground window before its menu opens, so a
/// `GetGUIThreadInfo(0, ..)` implementation - which reads whichever thread
/// owns the foreground window, ignoring the pid argument entirely - would
/// answer `true` for `self_pid` here too. Manually swapping
/// `classic_menu_mode_active`'s per-thread call to `GetGUIThreadInfo(0, ..)`
/// and re-running this test is the invert-verification for this property;
/// the shipped code takes no seam for it because the bug shape only exists
/// in the call site itself.
#[test]
fn menu_is_open_is_isolated_to_the_queried_process() {
    bootstrap();
    let _app_name_scope = FIXTURE_APP_NAME_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let fixture = MenuFixture::spawn().expect("the menu fixture starts");
    let fixture_pid = ProcessId::from(fixture.process_id());
    let self_pid = ProcessId::from(std::process::id());

    raise_handle(fixture.handle());
    if !foreground_granted(fixture.handle()) {
        eprintln!(
            "skip menu isolation: the OS declined the fixture window the foreground, so a              tracked popup menu is dismissed before it can be observed"
        );
        return;
    }
    fixture.open_context_menu();
    assert!(fixture.wait_for_menu_state(true, STATE_TIMEOUT));
    assert!(
        settles_to(STATE_TIMEOUT, true, || menu_is_open(
            fixture_pid,
            deadline(10_000)
        )
        .expect("predicate reads the fixture")),
        "the fixture's own pid must report its menu open"
    );
    assert!(
        !menu_is_open(self_pid, deadline(10_000)).expect("predicate reads this process"),
        "another process's open menu must not leak into this process's own pid"
    );

    fixture.dismiss_context_menu();
    assert!(fixture.wait_for_menu_state(false, STATE_TIMEOUT));
}

#[test]
fn a_non_pumping_candidate_returns_app_unresponsive_without_hanging() {
    bootstrap();
    let _app_name_scope = FIXTURE_APP_NAME_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let stalled = StalledFixture::create().expect("stalled fixture starts");
    let client = crate::tree::automation::automation_client().expect("automation client builds");
    let condition = menu_family_condition(&client).expect("menu-family condition builds");

    let started = Instant::now();
    let error = probe_candidate(&client, &condition, stalled.handle())
        .expect_err("a non-pumping window must be refused before a UI Automation read");

    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "the pump probe must bound the refusal, elapsed {:?}",
        started.elapsed()
    );
}

/// A snapshot handle opened inside the walk must be closed on the deadline
/// exit as well as the normal one. `wait --event` polls this path every
/// 200ms, so an exit that skips the close leaks one handle per expired
/// capture and exhausts the process over a long wait.
#[test]
fn an_expired_deadline_mid_walk_still_closes_the_snapshot_handle() {
    let _opens = thread_snapshot_calls::take();
    let _closes = thread_snapshot_closes::take();

    let expired = Deadline::after(1).expect("deadline builds");
    while !expired.is_expired() {
        std::thread::yield_now();
    }
    let outcome = classic_menu_mode_active(ProcessId::from(std::process::id()), expired);

    assert!(
        outcome.is_err(),
        "an expired deadline must refuse rather than complete the walk"
    );
    assert_eq!(
        thread_snapshot_calls::take(),
        thread_snapshot_closes::take(),
        "every ToolHelp snapshot opened by the walk must be closed on every exit path"
    );
}

/// The multi-target path takes one whole-desktop thread snapshot per call,
/// not one per target. `TH32CS_SNAPTHREAD` is unscoped, so a filter naming
/// several processes - two instances of one image name is ordinary - would
/// otherwise re-walk every thread on the desktop once per process on every
/// poll.
#[test]
fn menus_open_for_takes_one_snapshot_regardless_of_target_count() {
    let live: Vec<ProcessId> = crate::system::app_ops::process_snapshot()
        .expect("the process snapshot enumerates")
        .into_iter()
        .map(|row| row.pid)
        .filter(|pid| u32::from(*pid) != 0)
        .take(3)
        .collect();
    if live.len() < 2 {
        return;
    }

    let _drain = thread_snapshot_calls::take();
    let _outcome = menus_open_for(&live, deadline(10_000));

    assert_eq!(
        thread_snapshot_calls::take(),
        1,
        "{} targets must still cost exactly one thread snapshot",
        live.len()
    );
}

/// `CreateToolhelp32Snapshot` reports failure as `INVALID_HANDLE_VALUE`, which
/// is `-1`, never as a null handle. A guard written as `is_null()` cannot fire:
/// the failing call falls through, the enumeration loop never runs, and the
/// walk returns "no thread reported menu mode" - a masked native failure
/// reported as a confident negative. The classic source is the only one that
/// covers Win32 menu-bar dropdowns, so on that stack there is no second
/// opinion to catch it.
///
/// This drives the real guard with the value the API actually returns on
/// failure. Asserting facts about the constant alone would pass forever
/// regardless of what the guard compares against, which is the shape that let
/// the wrong guard survive three reviews.
#[test]
fn a_failed_snapshot_open_is_an_error_not_an_empty_enumeration() {
    let outcome = crate::system::runtime::thread_walk::force_open_failure::with(|| {
        menu_is_open(ProcessId::from(std::process::id()), deadline(10_000))
    });

    let error = outcome.expect_err(
        "a snapshot the OS refused to open must surface as an error, never as          a walk that completed and found no menu",
    );
    assert!(
        matches!(
            error.code,
            ErrorCode::AppUnresponsive | ErrorCode::Timeout | ErrorCode::ElementNotFound
        ),
        "the failure must stay inside the closed set the poll loop retries, got {:?}",
        error.code
    );
}

/// Split from this file so it stays inside the size cap. The agreement cases
/// need this module's fixture helpers, so they are a child of it rather than
/// a sibling.
#[path = "menu_state_agreement_tests.rs"]
mod agreement;
