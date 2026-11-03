//! Every `MenuFixture` spawned below is a re-exec'd child of this same test
//! binary, so it shares its process image name with every other such
//! fixture in this crate. Each test that spawns one holds
//! `test_support::FIXTURE_APP_NAME_LOCK` for the fixture's entire lifetime,
//! exactly as `system::wait_tests` and `system::menu_state_tests` hold it
//! around theirs, so this file's own fixture cannot coexist with a
//! concurrently running `list_apps`-by-name-resolving test and defeat that
//! test's resolution.

use super::*;

use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GUI_INMENUMODE, GUI_POPUPMENUMODE, GUI_SYSTEMMENUMODE, GUITHREADINFO, GetGUIThreadInfo,
    IsWindow,
};

use crate::system::fixture::test_support::FIXTURE_APP_NAME_LOCK;

const SETTLE: Duration = Duration::from_millis(250);
const STATE_TIMEOUT: Duration = Duration::from_secs(5);

/// The re-executed child process's entry point. Ignored so a normal run never
/// starts it; `MenuFixture::spawn` selects it by exact name.
#[test]
#[ignore = "runs only in the re-executed menu fixture host process"]
fn menu_fixture_host_process_entry() {
    assert!(
        is_menu_fixture_host_process(),
        "the menu host entry must not run without the host flag"
    );
    run_menu_fixture_as_host();
}

/// The fixture's own reported state, independent of any menu predicate under
/// test: the open and dismiss commands genuinely move the child's real
/// `TrackPopupMenu` tracking loop into and out of the tracked state.
#[test]
fn the_menu_fixture_opens_and_closes_the_context_menu_independently_of_any_predicate() {
    let _app_name_scope = FIXTURE_APP_NAME_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let fixture = MenuFixture::spawn().expect("the menu fixture starts");
    assert!(
        !fixture.menu_is_up(),
        "the fixture reports no menu up before any command is sent"
    );

    fixture.open_context_menu();
    assert!(
        fixture.wait_for_menu_state(true, STATE_TIMEOUT),
        "the fixture's own state must report the menu up after the open command"
    );

    fixture.dismiss_context_menu();
    assert!(
        fixture.wait_for_menu_state(false, STATE_TIMEOUT),
        "the fixture's own state must report the menu down after the dismiss command"
    );
}

/// A per-process menu predicate is only meaningful if opening the fixture's
/// menu in its own child process leaves the *test* process's threads
/// unaffected. This is the fixture half of that guarantee: a predicate built
/// on it later is exercised against a genuine cross-process signal, not a
/// same-process artifact.
#[test]
fn opening_the_fixture_menu_does_not_put_the_test_process_into_menu_mode() {
    let _app_name_scope = FIXTURE_APP_NAME_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let fixture = MenuFixture::spawn().expect("the menu fixture starts");

    fixture.open_context_menu();
    assert!(fixture.wait_for_menu_state(true, STATE_TIMEOUT));
    std::thread::sleep(SETTLE);

    assert!(
        !any_thread_reports_menu_mode(std::process::id()),
        "opening the child's menu must not put the test process into menu mode"
    );
    assert!(
        any_thread_reports_menu_mode(fixture.process_id()),
        "the fixture's own process must report menu mode while its menu is open"
    );

    fixture.dismiss_context_menu();
    assert!(fixture.wait_for_menu_state(false, STATE_TIMEOUT));
    std::thread::sleep(SETTLE);
    assert!(
        !any_thread_reports_menu_mode(fixture.process_id()),
        "the fixture's own process must leave menu mode once the menu is dismissed"
    );
}

/// Teardown is asserted by independent re-observation - `IsWindow`, not the
/// fixture's own bookkeeping - so a regression that merely stops updating an
/// internal flag cannot pass this test.
#[test]
fn the_menu_fixture_cleans_up_its_window_on_drop() {
    let _app_name_scope = FIXTURE_APP_NAME_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let fixture = MenuFixture::spawn().expect("the menu fixture starts");
    let handle = fixture.handle();
    assert!(
        window_exists(handle),
        "the fixture window exists while running"
    );

    drop(fixture);

    assert!(
        !window_exists(handle),
        "the fixture window must be gone after drop"
    );
}

fn window_exists(handle: isize) -> bool {
    handle != 0 && unsafe { IsWindow(handle as *mut std::ffi::c_void) } != 0
}

/// Whether any thread of `pid` currently reports classic Win32 menu-mode -
/// `GetGUIThreadInfo`'s `GUI_INMENUMODE` / `GUI_POPUPMENUMODE` /
/// `GUI_SYSTEMMENUMODE` flags (A23-1). Test-only measurement, independent of
/// any shipped menu predicate.
fn any_thread_reports_menu_mode(pid: u32) -> bool {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return false;
    }
    let mut entry = THREADENTRY32 {
        dwSize: size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    let mut found = false;
    let mut ok = unsafe { Thread32First(snapshot, &mut entry) };
    while ok != 0 {
        if entry.th32OwnerProcessID == pid && thread_reports_menu_mode(entry.th32ThreadID) {
            found = true;
            break;
        }
        ok = unsafe { Thread32Next(snapshot, &mut entry) };
    }
    unsafe { CloseHandle(snapshot) };
    found
}

fn thread_reports_menu_mode(thread_id: u32) -> bool {
    let mut info = GUITHREADINFO {
        cbSize: size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    if unsafe { GetGUIThreadInfo(thread_id, &mut info) } == 0 {
        return false;
    }
    info.flags & (GUI_INMENUMODE | GUI_POPUPMENUMODE | GUI_SYSTEMMENUMODE) != 0
}
