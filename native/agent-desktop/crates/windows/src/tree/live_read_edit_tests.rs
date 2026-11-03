//! Proves the shared live read's value projection reflects a same-process
//! edit made after resolution, rather than a stale or always-absent one -
//! not that production's out-of-process path converges, which this run
//! measured and could not confirm (see below).
//!
//! `live_read_tests.rs` used to call `live_value` and discard the result -
//! a call that can never fail, so it proved nothing about whether the
//! projection reflects the target's current state rather than a stale or
//! always-absent one. This module mutates the fixture's plain `EDIT`
//! control's window text directly with `SetWindowTextW`, the same primitive
//! `resolve_anchor_selector_wait_tests.rs` uses on the fixture's button, then
//! asserts the next live read reports the new text.
//!
//! Hosted on `LocalFixture`, not the crate's default `HostedFixture`,
//! measured rather than assumed: driven first through `HostedFixture`, a
//! `SetWindowTextW` mutation of the owning (separate) process's control was
//! not observed by `GetCurrentPropertyValue` for either `Value` or
//! `LegacyValue` even after a multi-second poll, a brand-new
//! `ElementFromHandle` taken after the mutation, and an explicit
//! `NotifyWinEvent` - the cross-process legacy-control value bridge in this
//! environment did not converge within any bound this test could use, which
//! is a fact about how production `get --property value` behaves against a
//! legacy out-of-process control, not only about this test's harness. The same mutation
//! against a `LocalFixture` control is observed on the very next read, which
//! is the narrower, in-process claim this module's tests actually establish.
//! `fixture.rs`'s warning on `LocalFixture` - "never use it to validate the
//! walk's failure classification or the cache policy" - does not cover this:
//! this test validates the projection's plumbing, not cross-process failure
//! taxonomy or the cache policy.

use crate::tree::automation::{automation_client, root_from_hwnd};
use crate::tree::element::UIAElement;
use crate::tree::fixture::{CONTENT_MARKER, LocalFixture, ensure_test_apartment};
use crate::tree::live_read::{live_value, read_live_element};
use crate::tree::properties::property_ids::TreeProperty;
use crate::tree::properties::{PropertyOutcome, PropertyValue, read_live};
use crate::tree::walk::walker_fake::deadline;
use std::ffi::c_void;
use std::time::{Duration, Instant};
use windows_sys::Win32::UI::WindowsAndMessaging::{FindWindowExW, GetWindowTextW, SetWindowTextW};

const UPDATED_CONTENT_MARKER: &str = "zzfixturecontentzz-updated";
const POLL_INTERVAL: Duration = Duration::from_millis(50);
const OVERALL_BUDGET: Duration = Duration::from_secs(5);

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn window_text(hwnd: *mut c_void) -> String {
    let mut buffer = [0u16; 256];
    let length = unsafe { GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
    let length = usize::try_from(length.max(0)).unwrap_or(0);
    String::from_utf16_lossy(&buffer[..length])
}

/// Finds the fixture's plain content `EDIT` control's window handle,
/// distinguished from the sibling `ES_PASSWORD` control by its known
/// starting text rather than by Z-order, which `CreateWindowExW` does not
/// document as stable across sibling controls of the same class. Used only
/// to mutate the control with `SetWindowTextW`; the element this test reads
/// through is resolved separately, the same way the walk resolves it.
fn find_content_edit_hwnd(parent: isize) -> *mut c_void {
    let class = wide("EDIT");
    let mut after: *mut c_void = std::ptr::null_mut();
    loop {
        let candidate = unsafe {
            FindWindowExW(
                parent as *mut c_void,
                after,
                class.as_ptr(),
                std::ptr::null(),
            )
        };
        assert!(
            !candidate.is_null(),
            "the fixture's content EDIT control was not found among its EDIT children"
        );
        if window_text(candidate).contains(CONTENT_MARKER) {
            return candidate;
        }
        after = candidate;
    }
}

fn set_window_text(hwnd: *mut c_void, text: &str) {
    let wide_text = wide(text);
    unsafe {
        SetWindowTextW(hwnd, wide_text.as_ptr());
    }
}

/// Walks the fixture's direct children through the raw view walker, the same
/// route `walker_source.rs`'s production tree walk uses and the same one
/// `properties_live_tests.rs` uses to reach individual controls - not
/// `ElementFromHandle` on the control's own window handle, which is a
/// different UI Automation entry point and is not this test's subject.
fn content_edit_element(root: &UIAElement) -> UIAElement {
    let client = automation_client().expect("a UIA client");
    let walker = client
        .get_raw_view_walker()
        .expect("the raw view walker is available");
    let mut children: Vec<uiautomation::UIElement> = Vec::new();
    if let Ok(mut current) = walker.get_first_child(&root.0) {
        loop {
            let next = walker.get_next_sibling(&current);
            children.push(current);
            match next {
                Ok(sibling) => current = sibling,
                Err(_) => break,
            }
        }
    }
    children
        .into_iter()
        .map(UIAElement::from)
        .find(|child| {
            matches!(
                read_live(child).0.get(TreeProperty::Value),
                PropertyOutcome::Known(PropertyValue::Text(ref value))
                    if value.contains(CONTENT_MARKER)
            )
        })
        .expect("the fixture exposes a control carrying the content marker")
}

/// The reader's live-state claim: a value edit made after resolution is what a subsequent
/// `get_live_value` read reports - proven end to end: the discarded
/// `let _ = live_value(&read)` this replaces could never fail, so an
/// always-`None` or permanently-stale projection would have reverted this
/// test green without it ever turning red.
///
/// Polled rather than asserted on the first read alone, so a small
/// convergence delay does not make this pin flaky; the module doc comment
/// records why the mutation itself is against `LocalFixture` rather than the
/// crate's default `HostedFixture`.
#[test]
fn a_value_edit_made_after_resolution_is_seen_by_the_next_live_read() {
    ensure_test_apartment();
    let fixture = LocalFixture::create().expect("a fixture host starts");
    let root = root_from_hwnd(fixture.handle(), deadline()).expect("the fixture window resolves");
    let element = content_edit_element(&root);
    let handle = element.into_native_handle();

    let edit_hwnd = find_content_edit_hwnd(fixture.handle());
    set_window_text(edit_hwnd, UPDATED_CONTENT_MARKER);

    let started = Instant::now();
    let mut observed = None;
    while started.elapsed() < OVERALL_BUDGET {
        let read = read_live_element(&handle, deadline()).expect("the shared read succeeds");
        let value = live_value(&read);
        if value.as_deref() == Some(UPDATED_CONTENT_MARKER) {
            observed = value;
            break;
        }
        std::thread::sleep(POLL_INTERVAL);
    }

    assert_eq!(
        observed,
        Some(UPDATED_CONTENT_MARKER.to_string()),
        "the live value projection never reflected the edit within the poll budget"
    );
}
