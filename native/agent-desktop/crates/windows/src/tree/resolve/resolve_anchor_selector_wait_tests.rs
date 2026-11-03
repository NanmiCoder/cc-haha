use crate::system::cursor_overlay::wide::wide;
use crate::tree::fixture::{HostedFixture, ensure_test_apartment};
use crate::tree::test_support::fixture_window;
use crate::tree::walk::walker_fake::deadline;
use agent_desktop_core::{
    LocatorMaterialization, LocatorResolveRequest, LocatorSelection, ObservationRoot, WindowInfo,
    commands::query::validate_selector, resolve_query,
};
use std::ffi::c_void;
use std::time::{Duration, Instant};
use windows_sys::Win32::UI::WindowsAndMessaging::{FindWindowExW, SetWindowTextW};

const POLL_INTERVAL: Duration = Duration::from_millis(50);
const APPEAR_DELAY: Duration = Duration::from_millis(300);
const OVERALL_BUDGET: Duration = Duration::from_secs(5);
const APPEARED_MARKER: &str = "fixture-button-appeared";

/// Locates the fixture's single `BUTTON` child by class name, from outside
/// the process that owns it - `FindWindowExW` walks the desktop's window
/// tree, not this process's own handle table, so a cross-process HWND is a
/// normal result rather than a special case.
fn find_button(parent: isize) -> *mut c_void {
    let class = wide("BUTTON");
    unsafe {
        FindWindowExW(
            parent as *mut c_void,
            std::ptr::null_mut(),
            class.as_ptr(),
            std::ptr::null(),
        )
    }
}

fn rename_button(hwnd: *mut c_void, text: &str) {
    let wide_text = wide(text);
    unsafe {
        SetWindowTextW(hwnd, wide_text.as_ptr());
    }
}

/// The exact shape `wait --selector`'s poll phase drives: `resolve_query`
/// with `LocatorSelection::First` and `LocatorMaterialization::None`
/// (`crates/core/src/commands/wait_selector.rs`'s `observe_selector`) never
/// reaches `resolve_locator_anchor` - it only walks the live tree - so this
/// is the mechanism a Windows `wait --selector` actually depends on.
fn selector_matches(
    adapter: &crate::adapter::WindowsAdapter,
    window: &WindowInfo,
    query: &agent_desktop_core::LocatorQuery,
) -> bool {
    let resolution = resolve_query(
        adapter,
        query,
        ObservationRoot::Window(window),
        &LocatorResolveRequest {
            selection: LocatorSelection::First,
            deadline: deadline(),
            max_raw_depth: 50,
            materialization: LocatorMaterialization::None,
            surface: None,
        },
    )
    .expect("a poll attempt against a live fixture window succeeds");
    resolution.meta.selection_complete && resolution.meta.total_matches > 0
}

/// `wait --selector` depends on Windows observing a late-appearing control.
/// Its poll condition is `resolve_query` in this exact shape - if that call
/// cannot observe a control that starts unmatched and becomes matched by a
/// real mutation made after the first poll, `wait --selector` can never
/// detect an element appearing later, no matter what core's retry loop does.
/// This mutates the fixture's button text on a delay and polls the same way
/// `observe_selector` does until it lands.
#[test]
fn a_selector_wait_style_poll_detects_a_control_that_appears_after_a_delay() {
    ensure_test_apartment();
    let fixture = HostedFixture::spawn().expect("a fixture host starts");
    let adapter = crate::adapter::WindowsAdapter::new();
    let window = fixture_window(&fixture);
    let query =
        validate_selector(&format!(":{APPEARED_MARKER}")).expect("a text-only selector is valid");

    assert!(
        !selector_matches(&adapter, &window, &query),
        "the marker text must not already be present before the mutation"
    );

    let button = find_button(fixture.handle());
    assert!(
        !button.is_null(),
        "the fixture exposes exactly one BUTTON control"
    );
    let button_handle = button as isize;
    std::thread::spawn(move || {
        std::thread::sleep(APPEAR_DELAY);
        rename_button(button_handle as *mut c_void, APPEARED_MARKER);
    });

    let started = Instant::now();
    let mut matched = false;
    while started.elapsed() < OVERALL_BUDGET {
        if selector_matches(&adapter, &window, &query) {
            matched = true;
            break;
        }
        std::thread::sleep(POLL_INTERVAL);
    }

    assert!(
        matched,
        "the selector-wait poll never observed the control after it appeared"
    );
}
