//! Per-process surface inventory tests, driven against the live desktop.
//!
//! Every fixture here is machine-global desktop state: the fixtures are
//! re-executed children that share one process image name, the menu detector
//! reads the whole desktop, and staging the foreground moves the real OS
//! foreground. Each test therefore holds `FIXTURE_APP_NAME_LOCK` for its
//! fixture's lifetime and, where it forces foreground or holds a menu open,
//! `fixture_window::on_screen_stage` second - the crate-wide acquisition
//! ordering - so a parallel suite can neither collide with nor dismiss
//! another test's staging. Each test stages, asserts, and restores its own
//! state, and runs on its own.
#![cfg(all(test, target_os = "windows"))]

use super::list_surfaces_for_process;
use crate::adapter::WindowsAdapter;
use crate::system::app_ops::process_snapshot;
use crate::system::fixture::test_support::{FIXTURE_APP_NAME_LOCK, settles_to, stage_foreground};
use crate::system::process_identity::token_for_pid;
use crate::system::window::window_enum::enumerate_top_level;
use crate::system::window::window_identity::live_window_owner;
use crate::system::window::window_ops::passes_filter;
use crate::tree::automation::root_from_hwnd;
use crate::tree::fixture::fixture_menu::{CONTEXT_MENU_ITEM_COUNT, MenuFixture};
use crate::tree::fixture::fixture_modal::ModalFixture;
use crate::tree::fixture::{HostedFixture, bootstrap};
use crate::tree::test_support::rooted_child_count as rooted_child_count_of;
use crate::tree::walk::walker_fake::deadline;
use agent_desktop_core::{
    ObservationOps, ProcessId, ProcessIdentity, SnapshotSurface, SurfaceInfo,
};

const STATE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

fn app_name_lock() -> std::sync::MutexGuard<'static, ()> {
    FIXTURE_APP_NAME_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn identity_for(pid: u32) -> ProcessIdentity {
    let token = token_for_pid(ProcessId::from(pid))
        .expect("the process table is readable")
        .unwrap_or_else(|| panic!("pid {pid} carries a generation token"));
    ProcessIdentity::new(ProcessId::from(pid), token)
}

fn ids_of_kind<'a>(surfaces: &'a [SurfaceInfo], kind: &str) -> Vec<&'a str> {
    surfaces
        .iter()
        .filter(|info| info.kind == kind)
        .map(|info| info.id.as_str())
        .collect()
}

/// Every kind a listing returns must parse back into the core surface
/// vocabulary under its own spelling. A classification that emitted a
/// hand-written or drifted string - `windowx` rather than `window` - fails
/// here instead of shipping a kind no `snapshot --surface` spelling accepts.
fn assert_kinds_round_trip(surfaces: &[SurfaceInfo]) {
    for info in surfaces {
        let parsed = serde_json::from_value::<SnapshotSurface>(serde_json::json!(info.kind))
            .unwrap_or_else(|error| {
                panic!(
                    "kind '{}' does not parse as a SnapshotSurface: {error}",
                    info.kind
                )
            });
        assert_eq!(
            parsed.as_str(),
            info.kind,
            "kind must round-trip to its own spelling"
        );
    }
}

fn rooted_child_count(handle: isize) -> usize {
    let root =
        root_from_hwnd(handle, deadline()).expect("the id roots through the observation stack");
    rooted_child_count_of(&root)
}

/// The adapter seam is part of the deliverable, so the plain-fixture leg
/// drives the trait exactly as a `list-surfaces` caller does, and the
/// returned window surface's id roots a real observation - an identity
/// nothing can observe is not a surface listing.
#[test]
fn the_fixture_window_is_a_window_surface_whose_id_snapshots() {
    bootstrap();
    let _app_name_scope = app_name_lock();
    let fixture = HostedFixture::spawn().expect("the fixture spawns");

    let surfaces = ObservationOps::list_surfaces(
        &WindowsAdapter::new(),
        identity_for(fixture.process_id()),
        deadline(),
    )
    .expect("the fixture process inventories");

    assert_kinds_round_trip(&surfaces);
    let id = format!("w-{}", fixture.handle());
    let window = surfaces
        .iter()
        .find(|info| info.kind == "window" && info.id == id)
        .unwrap_or_else(|| panic!("the fixture window is a window surface: {surfaces:?}"));
    assert!(
        window.item_count.is_none(),
        "a window surface is not a counted inventory"
    );
    assert!(
        rooted_child_count(fixture.handle()) > 0,
        "the window surface's id snapshots a non-empty tree"
    );
}

#[test]
fn the_foreground_window_is_also_a_focused_surface() {
    bootstrap();
    let _app_name_scope = app_name_lock();
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let fixture = HostedFixture::spawn().expect("the fixture spawns");
    if !stage_foreground(fixture.handle()) {
        eprintln!("skip focused leg: the OS declined the fixture window the foreground");
        return;
    }

    let surfaces = list_surfaces_for_process(identity_for(fixture.process_id()), deadline())
        .expect("the fixture process inventories");

    assert_kinds_round_trip(&surfaces);
    let id = format!("w-{}", fixture.handle());
    assert!(
        ids_of_kind(&surfaces, "window").contains(&id.as_str()),
        "the fixture window is a window surface: {surfaces:?}"
    );
    assert!(
        ids_of_kind(&surfaces, "focused").contains(&id.as_str()),
        "the foreground window is also a focused surface: {surfaces:?}"
    );
}

/// The modal fixture's owner is disabled while its modal is up, so the
/// inventory classifies the modal exactly the way `window_is_modal_sheet`
/// classifies it for the sheet surface path. Both windows are window
/// surfaces, and the sheet addresses the modal window - an id distinct from
/// the parent window's.
#[test]
fn a_staged_modal_presents_a_sheet_surface_distinct_from_its_owner_window() {
    bootstrap();
    let _app_name_scope = app_name_lock();
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let modal = ModalFixture::spawn().expect("the modal fixture spawns");
    modal.open();
    assert!(modal.wait_for_modal_state(true, STATE_TIMEOUT));
    if !stage_foreground(modal.modal_handle()) {
        eprintln!("skip sheet leg: the OS declined the modal window the foreground");
        return;
    }

    let surfaces = list_surfaces_for_process(identity_for(modal.process_id()), deadline())
        .expect("the modal fixture process inventories");

    assert_kinds_round_trip(&surfaces);
    let owner_id = format!("w-{}", modal.owner_handle());
    let modal_id = format!("w-{}", modal.modal_handle());
    assert!(
        ids_of_kind(&surfaces, "window").contains(&owner_id.as_str()),
        "every window is a window surface, the owner included: {surfaces:?}"
    );
    assert!(
        ids_of_kind(&surfaces, "window").contains(&modal_id.as_str()),
        "the modal window itself is also a window surface: {surfaces:?}"
    );
    let sheet = surfaces
        .iter()
        .find(|info| info.kind == "sheet")
        .expect("the staged modal is classified as a sheet");
    assert_eq!(sheet.id, modal_id, "the sheet addresses the modal window");
    assert_ne!(
        sheet.id, owner_id,
        "the sheet's id differs from the parent window's"
    );

    modal.close();
    assert!(modal.wait_for_modal_state(false, STATE_TIMEOUT));
}

/// The menu surface is asserted against the fixture's own staged count
/// constant, not a literal, so changing what the fixture stages without
/// changing the inventory cannot pass vacuously. The detector lags the
/// fixture's own up-flag by a short, variable span, so the surface's
/// appearance is awaited through the same settle helper the detector's own
/// tests use.
#[test]
fn an_open_menu_presents_a_menu_surface_with_the_staged_item_count() {
    bootstrap();
    let _app_name_scope = app_name_lock();
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let menu = MenuFixture::spawn().expect("the menu fixture spawns");
    let inventory = || {
        list_surfaces_for_process(identity_for(menu.process_id()), deadline())
            .map(|surfaces| ids_of_kind(&surfaces, "menu").len() == 1)
            .is_ok_and(|present| present)
    };

    menu.open_context_menu();
    assert!(menu.wait_for_menu_state(true, STATE_TIMEOUT));
    assert!(
        settles_to(STATE_TIMEOUT, true, inventory),
        "the open fixture menu must surface as a menu surface"
    );

    let surfaces = list_surfaces_for_process(identity_for(menu.process_id()), deadline())
        .expect("the menu fixture process inventories");
    assert_kinds_round_trip(&surfaces);
    let menu_surface = surfaces
        .iter()
        .find(|info| info.kind == "menu")
        .expect("the settle above proved a menu surface is present");
    assert_eq!(
        menu_surface.item_count,
        Some(CONTEXT_MENU_ITEM_COUNT),
        "item_count matches the number of items the fixture staged"
    );
    let handle = menu_surface
        .id
        .strip_prefix("w-")
        .and_then(|digits| digits.parse::<isize>().ok())
        .expect("a menu surface id is a w-<hwnd> handle");
    assert!(
        rooted_child_count(handle) > 0,
        "the menu surface's id roots a real tree"
    );

    menu.dismiss_context_menu();
    assert!(menu.wait_for_menu_state(false, STATE_TIMEOUT));
    let closed = list_surfaces_for_process(identity_for(menu.process_id()), deadline())
        .expect("the menu fixture process still inventories after dismissal");
    assert!(
        ids_of_kind(&closed, "menu").is_empty(),
        "the dismissed menu is no longer presented: {closed:?}"
    );
}

/// A process that presents no agent-facing window answers an empty list and
/// `ok` - a statement about that process, never `PLATFORM_NOT_SUPPORTED` and
/// never an error. The process is found live, by name, and its windowless
/// premise is verified against the desktop's own enumeration before the
/// assertion is made.
#[test]
fn a_process_with_no_windows_returns_an_empty_inventory() {
    let pid = windowless_process_pid().expect("a live windowless process exists on this desktop");

    let surfaces = list_surfaces_for_process(identity_for(pid), deadline())
        .expect("a windowless process inventories successfully");

    assert!(
        surfaces.is_empty(),
        "a process with no agent-facing windows presents no surfaces: {surfaces:?}"
    );
}

/// Finds a live process that owns no agent-facing top-level window: a
/// background-system image name from the live process table whose pid owns
/// nothing the census filter would admit, and whose generation token is
/// readable so the inventory's identity check can be satisfied.
fn windowless_process_pid() -> Option<u32> {
    const WINDOWLESS_NAMES: [&str; 5] = [
        "svchost.exe",
        "conhost.exe",
        "fontdrvhost.exe",
        "spoolsv.exe",
        "services.exe",
    ];
    let mut window_owners = std::collections::HashSet::new();
    enumerate_top_level(|window| {
        if let Some(owner) = live_window_owner(window.handle) {
            if passes_filter(&window) {
                window_owners.insert(u32::from(owner));
            }
        }
        true
    })
    .expect("the desktop's top-level windows enumerate");
    process_snapshot()
        .ok()?
        .into_iter()
        .find(|row| {
            WINDOWLESS_NAMES.contains(&row.name.to_ascii_lowercase().as_str())
                && !window_owners.contains(&u32::from(row.pid))
        })
        .and_then(|row| {
            token_for_pid(row.pid)
                .ok()
                .flatten()
                .map(|_| u32::from(row.pid))
        })
}
