//! Every `ModalFixture` spawned below is a re-exec'd child of this same test
//! binary, so it shares its process image name with every other such
//! fixture in this crate. Each test that spawns one holds
//! `test_support::FIXTURE_APP_NAME_LOCK` for the fixture's entire lifetime,
//! exactly as `system::signal_surfaces_tests` and
//! `system::wait_surface_live_tests` hold it around theirs, so this file's
//! own fixture cannot coexist with a concurrently running
//! `list_apps`-by-name-resolving test and defeat that test's resolution.

use super::*;

use agent_desktop_core::Deadline;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::IsWindowEnabled;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GET_WINDOW_CMD, GW_OWNER, GWL_EXSTYLE, GetWindow, GetWindowLongPtrW, IsWindow,
};

use crate::system::fixture::test_support::FIXTURE_APP_NAME_LOCK;

const STATE_TIMEOUT: Duration = Duration::from_secs(5);

/// The re-executed child process's entry point. Ignored so a normal run never
/// starts it; `ModalFixture::spawn` selects it by exact name.
#[test]
#[ignore = "runs only in the re-executed modal fixture host process"]
fn modal_fixture_host_process_entry() {
    assert!(
        is_modal_fixture_host_process(),
        "the modal host entry must not run without the host flag"
    );
    run_modal_fixture_as_host();
}

/// The modal window is owned and carries `WS_EX_DLGMODALFRAME` at all times,
/// and UI Automation's own `WindowIsModal` read - the same property
/// `crates/windows/src/tree/surfaces.rs` classifies a `Sheet` surface from -
/// agrees once the window is shown, matching every property A23-9 measured
/// on a real `MessageBox`. None of this is asserted against a title.
#[test]
fn the_modal_fixture_window_is_owned_and_carries_the_measured_modal_properties() {
    crate::tree::fixture::bootstrap();
    let _app_name_scope = FIXTURE_APP_NAME_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let fixture = ModalFixture::spawn().expect("the modal fixture starts");
    assert_ne!(fixture.process_id(), std::process::id());
    assert!(
        !fixture.modal_is_up(),
        "the fixture reports no modal up before any command is sent"
    );

    assert_eq!(
        window_owner(fixture.modal_handle()),
        fixture.owner_handle(),
        "the modal window is owned by the fixture's owner window"
    );
    assert!(
        has_dlgmodalframe(fixture.modal_handle()),
        "the modal window carries WS_EX_DLGMODALFRAME regardless of visibility"
    );
    assert!(
        !window_is_visible(fixture.modal_handle()),
        "the modal window starts hidden"
    );

    fixture.open();
    assert!(fixture.wait_for_modal_state(true, STATE_TIMEOUT));
    assert!(window_is_visible(fixture.modal_handle()));
    assert!(
        !window_is_enabled(fixture.owner_handle()),
        "the owner is disabled while its modal is shown, matching a real modal dialog"
    );

    let deadline = Deadline::standard().expect("a standard deadline");
    let root = crate::tree::automation::root_from_hwnd(fixture.modal_handle(), deadline)
        .expect("the modal window resolves to a UI Automation root");
    assert!(
        crate::tree::surfaces::window_is_modal_sheet(&root),
        "UI Automation's WindowIsModal must agree once the modal is shown"
    );

    fixture.close();
    assert!(fixture.wait_for_modal_state(false, STATE_TIMEOUT));
    assert!(!window_is_visible(fixture.modal_handle()));
    assert!(window_is_enabled(fixture.owner_handle()));
}

/// Teardown is asserted by independent re-observation of both windows, not
/// the fixture's own bookkeeping.
#[test]
fn the_modal_fixture_cleans_up_owner_and_modal_on_drop() {
    let _app_name_scope = FIXTURE_APP_NAME_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let fixture = ModalFixture::spawn().expect("the modal fixture starts");
    let owner = fixture.owner_handle();
    let modal = fixture.modal_handle();
    assert!(window_exists(owner));
    assert!(window_exists(modal));

    drop(fixture);

    assert!(
        !window_exists(owner),
        "the owner window must be gone after drop"
    );
    assert!(
        !window_exists(modal),
        "the modal window must be gone after drop"
    );
}

fn window_exists(handle: isize) -> bool {
    handle != 0 && unsafe { IsWindow(handle as *mut std::ffi::c_void) } != 0
}

fn window_is_visible(handle: isize) -> bool {
    fixture_window::geometry(handle).visible
}

fn window_is_enabled(handle: isize) -> bool {
    unsafe { IsWindowEnabled(handle as *mut std::ffi::c_void) != 0 }
}

fn window_owner(handle: isize) -> isize {
    let owner: GET_WINDOW_CMD = GW_OWNER;
    unsafe { GetWindow(handle as *mut std::ffi::c_void, owner) as isize }
}

fn has_dlgmodalframe(handle: isize) -> bool {
    let style = unsafe { GetWindowLongPtrW(handle as *mut std::ffi::c_void, GWL_EXSTYLE) };
    (style as u32 & WS_EX_DLGMODALFRAME) != 0
}
