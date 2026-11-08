//! Windows-only: drives the frame-identity seam against the live desktop's
//! real `ApplicationFrameHost` population (A26-8) at the predicate and
//! listing level - the phantom-frame exclusion, the untouched ordinary
//! window, and the single-pass cost shape. The Settings-staging legs that
//! need a live hosted application live in `frame_identity_settings_tests`.
#![cfg(target_os = "windows")]

use super::hosted_application_pid;
use crate::system::process_identity::process_image_name;
use crate::system::window::window_enum::{WindowHandle, enumerate_top_level};
use crate::system::window::window_identity::live_window_owner;
use crate::system::window::window_ops::{
    enumeration_calls, list_windows_live, parse_handle, window_class_name,
};
use crate::tree::fixture::{HostedFixture, bootstrap};
use agent_desktop_core::{ProcessId, WindowFilter};

const FRAME_CLASS: &str = "ApplicationFrameWindow";
const CORE_WINDOW_CLASS: &str = "Windows.UI.Core.CoreWindow";
const SHELL_IMAGE: &str = "explorer.exe";

use crate::system::fixture::test_time::deadline;

/// The phantom-frame exclusion (A26-8): a shell-
/// owned `ApplicationFrameWindow` with no `CoreWindow` child - found live by
/// an independent recursive child walk - must not classify as hosted, and
/// every frame-shaped listing entry whose independent walk finds no hosted
/// `CoreWindow` must carry its own process's pid and image name.
#[test]
fn an_application_frame_window_without_a_hosted_core_window_keeps_its_own_identity() {
    bootstrap();
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let candidates = shell_owned_frames_without_core_window_child();
    if candidates.is_empty() {
        eprintln!(
            "skip phantom-frame: no shell-owned ApplicationFrameWindow without a CoreWindow child exists on the desktop right now (A26-8 measured one; the shell owns that population)"
        );
        return;
    }
    for handle in &candidates {
        assert!(
            hosted_application_pid(*handle).is_none(),
            "a frame whose children share its own process must not classify as a hosted application"
        );
    }

    let listed = list_windows_live(&WindowFilter::default(), deadline(15_000))
        .expect("the listing succeeds");
    for window in &listed {
        let handle = parse_handle(&window.id);
        if window_class_name(handle).as_deref() != Some(FRAME_CLASS) {
            continue;
        }
        if has_core_window_child(handle) {
            continue;
        }
        let owner = live_window_owner(handle).expect("a listed window's owner is readable");
        assert_eq!(
            u32::from(window.pid),
            u32::from(owner),
            "a frame with no hosted CoreWindow lists its own process, not a phantom application"
        );
        let owner_image = process_image_name(owner).unwrap_or_default();
        assert_eq!(
            window.app.to_ascii_lowercase(),
            owner_image.to_ascii_lowercase(),
            "a frame with no hosted CoreWindow lists its own image name"
        );
    }
}

/// An ordinary window's identity is exactly its own process's - the rewrite
/// must not touch windows the frame predicate does not name.
#[test]
fn an_ordinary_win32_window_s_identity_is_unchanged() {
    bootstrap();
    let fixture = HostedFixture::spawn().expect("a fixture host starts");
    let pid = ProcessId::from(fixture.process_id());
    let listed = list_windows_live(&WindowFilter::default(), deadline(15_000))
        .expect("the listing succeeds");
    let entry = listed
        .iter()
        .find(|window| window.pid == pid)
        .expect("the fixture's window is listed");
    let expected_app = process_image_name(pid).expect("the fixture's image name is readable");
    assert_eq!(
        entry.app, expected_app,
        "an ordinary window's app is its own process's image name"
    );
    assert_eq!(
        entry.id,
        format!("w-{}", fixture.handle()),
        "the id is the fixture's own handle"
    );
    assert_eq!(
        u32::from(entry.pid),
        fixture.process_id(),
        "the pid is the fixture's own process"
    );
}

/// The rewrite's reads - the class read included - ride the single
/// enumeration pass `list_windows` already runs, with no second walk. The
/// no-match filter lists nothing, so no verification retry can inflate the
/// count: one listing call, exactly one enumeration.
#[test]
fn the_hosted_frame_detection_rides_the_existing_enumeration_pass() {
    bootstrap();
    enumeration_calls::take();
    let filter = WindowFilter {
        focused_only: false,
        app: Some(String::from("zz-agent-desktop-no-such-app")),
    };
    let windows = list_windows_live(&filter, deadline(15_000)).expect("the listing succeeds");
    assert!(windows.is_empty(), "the no-match filter lists nothing");
    assert_eq!(
        enumeration_calls::take(),
        1,
        "the identity reads ride the single enumeration pass"
    );
}

/// Frames owned by the shell with no `CoreWindow` child anywhere beneath
/// them - the A26-8 phantom population - selected by an independent
/// recursive child walk, not by the shipped predicate. The visitor never
/// panics: it runs across an FFI boundary.
fn shell_owned_frames_without_core_window_child() -> Vec<WindowHandle> {
    let mut candidates = Vec::new();
    enumerate_top_level(|window| {
        if window_class_name(window.handle).as_deref() != Some(FRAME_CLASS) {
            return true;
        }
        let Some(owner) = live_window_owner(window.handle) else {
            return true;
        };
        let shell_owned = process_image_name(owner)
            .map(|image| image.eq_ignore_ascii_case(SHELL_IMAGE))
            .unwrap_or(false);
        if !shell_owned || has_core_window_child(window.handle) {
            return true;
        }
        candidates.push(window.handle);
        true
    })
    .expect("enumeration succeeds");
    candidates
}

/// The test-side twin of the shipped child read: a recursive walk over every
/// descendant, reporting whether any carries the `CoreWindow` class. Returns
/// false when the frame is already gone - a raced frame has no children.
fn has_core_window_child(frame: WindowHandle) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::EnumChildWindows;

    unsafe extern "system" fn callback(child: WindowHandle, lparam: isize) -> i32 {
        let found = unsafe { &mut *(lparam as *mut bool) };
        if window_class_name(child).as_deref() == Some(CORE_WINDOW_CLASS) {
            *found = true;
            return 0;
        }
        1
    }

    let mut found = false;
    unsafe { EnumChildWindows(frame, Some(callback), &mut found as *mut bool as isize) };
    found
}
