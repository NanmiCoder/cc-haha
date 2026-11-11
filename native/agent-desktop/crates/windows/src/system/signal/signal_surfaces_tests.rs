//! Windows-only: drives real fixtures (`ModalFixture`, `MenuFixture`) through
//! `app_scoped_surfaces` and, for the lifecycle assertions, through core's own
//! `diff_signals` rather than a paraphrase of it.
//!
//! Every `ModalFixture`/`MenuFixture` here is a re-exec'd child of this same
//! test binary, so it shares its process image name with every other such
//! fixture in this crate. Each test below holds
//! `test_support::FIXTURE_APP_NAME_LOCK` for its fixture's entire lifetime so
//! it cannot coexist with another lock-holding test's fixture and defeat that
//! test's `list_apps`-by-name resolution.
#![cfg(target_os = "windows")]

use super::*;

use std::time::Duration;

use agent_desktop_core::{
    EventKind, SignalBaseline, SignalCompleteness, SnapshotSurface, UiEvent, diff_signals,
};

use crate::system::fixture::test_support::FIXTURE_APP_NAME_LOCK;
use crate::system::process_identity;
use crate::tree::fixture::bootstrap;
use crate::tree::fixture::fixture_menu::MenuFixture;
use crate::tree::fixture::fixture_modal::ModalFixture;

const SETTLE: Duration = Duration::from_millis(250);
const STATE_TIMEOUT: Duration = Duration::from_secs(5);

use crate::system::fixture::test_time::deadline;

fn app_for_pid(pid: u32, name: &str) -> AppInfo {
    let process_id = ProcessId::from(pid);
    let instance = process_identity::token_for_pid(process_id)
        .expect("a live process's token is readable")
        .expect("a live process has a readable generation token");
    AppInfo {
        name: name.to_string(),
        pid: process_id,
        bundle_id: None,
        process_instance: Some(instance),
        presentation: None,
    }
}

fn capture(apps: &[AppInfo]) -> SignalBaseline {
    let surfaces = app_scoped_surfaces(apps, deadline(10_000)).expect("surface scan succeeds");
    SignalBaseline {
        windows: Vec::new(),
        apps: Vec::new(),
        surfaces,
        completeness: SignalCompleteness {
            windows: false,
            apps: false,
            surfaces: true,
        },
    }
}

fn surface_appeared_count(events: &[UiEvent], surface: SnapshotSurface) -> usize {
    events
        .iter()
        .filter(|event| matches!(event.kind, EventKind::SurfaceAppeared { surface: kind } if kind == surface))
        .count()
}

fn surface_dismissed_count(events: &[UiEvent], surface: SnapshotSurface) -> usize {
    events
        .iter()
        .filter(|event| matches!(event.kind, EventKind::SurfaceDismissed { surface: kind } if kind == surface))
        .count()
}

#[test]
fn a_modal_appearing_between_two_captures_produces_exactly_one_sheet_appeared_through_core_diff() {
    bootstrap();
    let _app_name_scope = FIXTURE_APP_NAME_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let fixture = ModalFixture::spawn().expect("the modal fixture starts");
    let app = app_for_pid(fixture.process_id(), "modal-fixture");

    let before = capture(std::slice::from_ref(&app));

    fixture.open();
    assert!(fixture.wait_for_modal_state(true, STATE_TIMEOUT));
    std::thread::sleep(SETTLE);

    let after = capture(std::slice::from_ref(&app));
    let events = diff_signals(&before, &after);

    assert_eq!(
        surface_appeared_count(&events, SnapshotSurface::Sheet),
        1,
        "exactly one Sheet must appear: {events:?}"
    );
}

#[test]
fn dismissing_the_modal_produces_exactly_one_sheet_dismissed_through_core_diff() {
    bootstrap();
    let _app_name_scope = FIXTURE_APP_NAME_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let fixture = ModalFixture::spawn().expect("the modal fixture starts");
    let app = app_for_pid(fixture.process_id(), "modal-fixture");

    fixture.open();
    assert!(fixture.wait_for_modal_state(true, STATE_TIMEOUT));
    std::thread::sleep(SETTLE);
    let open = capture(std::slice::from_ref(&app));

    fixture.close();
    assert!(fixture.wait_for_modal_state(false, STATE_TIMEOUT));
    std::thread::sleep(SETTLE);
    let closed = capture(std::slice::from_ref(&app));

    let events = diff_signals(&open, &closed);

    assert_eq!(
        surface_dismissed_count(&events, SnapshotSurface::Sheet),
        1,
        "exactly one Sheet must be dismissed: {events:?}"
    );
}

#[test]
fn the_modal_staying_open_across_two_captures_produces_zero_surface_events() {
    bootstrap();
    let _app_name_scope = FIXTURE_APP_NAME_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let fixture = ModalFixture::spawn().expect("the modal fixture starts");
    let app = app_for_pid(fixture.process_id(), "modal-fixture");

    fixture.open();
    assert!(fixture.wait_for_modal_state(true, STATE_TIMEOUT));
    std::thread::sleep(SETTLE);

    let first = capture(std::slice::from_ref(&app));
    let second = capture(std::slice::from_ref(&app));
    let events = diff_signals(&first, &second);

    assert!(
        events.is_empty(),
        "an unchanged modal must not regenerate under a fresh id: {events:?}"
    );

    fixture.close();
    assert!(fixture.wait_for_modal_state(false, STATE_TIMEOUT));
}

#[test]
fn an_open_menu_produces_a_menu_surface_signal_and_no_event_while_it_stays_open() {
    bootstrap();
    let _app_name_scope = FIXTURE_APP_NAME_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let fixture = MenuFixture::spawn().expect("the menu fixture starts");
    let app = app_for_pid(fixture.process_id(), "menu-fixture");

    let before = capture(std::slice::from_ref(&app));

    fixture.open_context_menu();
    assert!(fixture.wait_for_menu_state(true, STATE_TIMEOUT));
    std::thread::sleep(SETTLE);
    let opened = capture(std::slice::from_ref(&app));

    let opened_events = diff_signals(&before, &opened);
    assert_eq!(
        surface_appeared_count(&opened_events, SnapshotSurface::Menu),
        1,
        "exactly one Menu surface must appear: {opened_events:?}"
    );

    let still_open = capture(std::slice::from_ref(&app));
    let steady_events = diff_signals(&opened, &still_open);
    assert!(
        steady_events.is_empty(),
        "a menu that stays open must not re-fire: {steady_events:?}"
    );

    fixture.dismiss_context_menu();
    assert!(fixture.wait_for_menu_state(false, STATE_TIMEOUT));
}

#[test]
fn two_simultaneously_open_sheets_of_the_same_kind_produce_two_distinct_signals() {
    bootstrap();
    let _app_name_scope = FIXTURE_APP_NAME_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let first_fixture = ModalFixture::spawn().expect("the first modal fixture starts");
    let second_fixture = ModalFixture::spawn().expect("the second modal fixture starts");
    let first_app = app_for_pid(first_fixture.process_id(), "modal-fixture-a");
    let second_app = app_for_pid(second_fixture.process_id(), "modal-fixture-b");
    let first_pid = first_app.pid;
    let second_pid = second_app.pid;

    first_fixture.open();
    assert!(first_fixture.wait_for_modal_state(true, STATE_TIMEOUT));
    second_fixture.open();
    assert!(second_fixture.wait_for_modal_state(true, STATE_TIMEOUT));
    std::thread::sleep(SETTLE);

    let surfaces = app_scoped_surfaces(&[first_app, second_app], deadline(10_000))
        .expect("surface scan succeeds");
    let sheets: Vec<_> = surfaces
        .iter()
        .filter(|surface| surface.kind == SnapshotSurface::Sheet)
        .collect();

    assert_eq!(
        sheets.len(),
        2,
        "both open modals must be reported: {surfaces:?}"
    );
    assert_ne!(
        sheets[0].id, sheets[1].id,
        "each simultaneously-open sheet must carry a distinguishing id"
    );

    let first_sheet = sheets
        .iter()
        .find(|surface| surface.pid == first_pid)
        .expect("the first fixture's sheet was reported");
    assert_eq!(
        first_sheet.id,
        format!("w-{}", first_fixture.modal_handle() as usize),
        "a sheet id must be derived from its own window's handle, not a positional index"
    );
    let second_sheet = sheets
        .iter()
        .find(|surface| surface.pid == second_pid)
        .expect("the second fixture's sheet was reported");
    assert_eq!(
        second_sheet.id,
        format!("w-{}", second_fixture.modal_handle() as usize),
        "a sheet id must be derived from its own window's handle, not a positional index"
    );

    first_fixture.close();
    second_fixture.close();
}

#[test]
fn every_emitted_surface_carries_a_non_empty_process_instance_and_the_filtered_pid() {
    bootstrap();
    let _app_name_scope = FIXTURE_APP_NAME_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let fixture = ModalFixture::spawn().expect("the modal fixture starts");
    let app = app_for_pid(fixture.process_id(), "modal-fixture");
    let expected_pid = app.pid;
    let expected_instance = app
        .process_instance
        .clone()
        .expect("the fixture's token was read");

    fixture.open();
    assert!(fixture.wait_for_modal_state(true, STATE_TIMEOUT));
    std::thread::sleep(SETTLE);

    let surfaces = app_scoped_surfaces(std::slice::from_ref(&app), deadline(10_000))
        .expect("surface scan succeeds");

    assert!(!surfaces.is_empty(), "the open modal must be reported");
    for surface in &surfaces {
        assert!(
            !surface.process_instance.is_empty(),
            "process_instance must never be fabricated as empty"
        );
        assert_eq!(surface.pid, expected_pid);
        assert_eq!(surface.process_instance, expected_instance);
    }

    fixture.close();
}

#[test]
fn a_surface_belonging_to_a_different_process_is_never_emitted_under_a_process_filter() {
    bootstrap();
    let _app_name_scope = FIXTURE_APP_NAME_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let target = ModalFixture::spawn().expect("the target modal fixture starts");
    let other = ModalFixture::spawn().expect("the other modal fixture starts");
    let target_app = app_for_pid(target.process_id(), "target-fixture");

    target.open();
    assert!(target.wait_for_modal_state(true, STATE_TIMEOUT));
    other.open();
    assert!(other.wait_for_modal_state(true, STATE_TIMEOUT));
    std::thread::sleep(SETTLE);

    let surfaces = app_scoped_surfaces(std::slice::from_ref(&target_app), deadline(10_000))
        .expect("surface scan succeeds");

    assert!(
        surfaces.iter().all(|surface| surface.pid == target_app.pid),
        "a process not named by the filter must never surface: {surfaces:?}"
    );
    assert_eq!(
        surfaces
            .iter()
            .filter(|surface| surface.kind == SnapshotSurface::Sheet)
            .count(),
        1,
        "only the target's own modal may surface, never the other fixture's: {surfaces:?}"
    );

    target.close();
    other.close();
}
