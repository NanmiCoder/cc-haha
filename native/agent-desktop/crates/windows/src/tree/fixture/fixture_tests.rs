use super::*;
use crate::tree::automation::{automation_client, uia_error};
use crate::tree::fixture::bootstrap;
use agent_desktop_core::Deadline;
use std::time::Duration;
use uiautomation::types::UIProperty;
use uiautomation::{UIElement, UITreeWalker};

const SETTLE: Duration = Duration::from_millis(250);

/// The re-executed child process's entry point. Ignored so a normal run never
/// starts it; `HostedFixture::spawn` selects it by exact name.
#[test]
#[ignore = "runs only in the re-executed fixture host process"]
fn fixture_host_process_entry() {
    assert!(
        is_host_process(),
        "the host entry must not run without the host flag"
    );
    run_as_host();
}

fn raw_view_walker() -> UITreeWalker {
    let client = automation_client().expect("a UIA client is available");
    client
        .get_raw_view_walker()
        .map_err(|error| uia_error(&error, "create a raw view walker"))
        .expect("the raw view walker is available")
}

fn direct_children(walker: &UITreeWalker, parent: &UIElement) -> Vec<UIElement> {
    let mut children = Vec::new();
    let Ok(mut current) = walker.get_first_child(parent) else {
        return children;
    };
    loop {
        let next = walker.get_next_sibling(&current);
        children.push(current);
        match next {
            Ok(sibling) => current = sibling,
            Err(_) => return children,
        }
    }
}

fn descendant_count(walker: &UITreeWalker, root: &UIElement, depth: u32) -> usize {
    if depth >= 8 {
        return 0;
    }
    let children = direct_children(walker, root);
    children.iter().fold(children.len(), |total, child| {
        total + descendant_count(walker, child, depth + 1)
    })
}

fn resolve(handle: isize) -> crate::tree::element::UIAElement {
    crate::tree::automation::root_from_hwnd(
        handle,
        Deadline::standard().expect("a standard deadline"),
    )
    .expect("the fixture window resolves to a UI Automation root")
}

#[test]
fn a_child_process_fixture_resolves_a_root_that_exposes_its_controls() {
    bootstrap();
    let fixture = HostedFixture::spawn().expect("the fixture host starts");

    assert_ne!(fixture.process_id(), std::process::id());

    let root = resolve(fixture.handle());
    let walker = raw_view_walker();

    assert!(
        descendant_count(&walker, &root.0, 0) > 0,
        "a cross-process fixture root must expose descendants"
    );
}

#[test]
fn the_fixture_window_is_visible_with_a_non_zero_rect() {
    let fixture = LocalFixture::create().expect("the fixture window is created");
    let geometry = fixture.geometry();

    assert!(geometry.visible, "the provider excludes invisible windows");
    assert!(geometry.width > 0 && geometry.height > 0);
}

#[test]
fn a_fixture_tears_down_and_a_second_one_succeeds_in_the_same_process() {
    bootstrap();
    let first = LocalFixture::create().expect("the first fixture is created");
    let first_handle = first.handle();
    drop(first);

    let second = LocalFixture::create().expect("the second fixture is created");

    assert_ne!(second.handle(), 0);
    assert!(second.geometry().width > 0);
    assert!(
        crate::tree::automation::root_from_hwnd(
            first_handle,
            Deadline::standard().expect("a standard deadline"),
        )
        .is_err(),
        "a torn-down fixture must not still resolve"
    );
}

#[test]
fn two_fixtures_created_concurrently_do_not_interfere() {
    bootstrap();
    let first = LocalFixture::create().expect("the first fixture is created");
    let second = LocalFixture::create().expect("the second fixture is created");

    assert_ne!(first.handle(), second.handle());

    let walker = raw_view_walker();
    let first_root = resolve(first.handle());
    let second_root = resolve(second.handle());

    assert!(descendant_count(&walker, &first_root.0, 0) > 0);
    assert!(descendant_count(&walker, &second_root.0, 0) > 0);
}

/// The client automating its own UI must call from a thread that owns no
/// windows. A call issued on the pump thread would block on its own
/// `WM_GETOBJECT` and deadlock, so the harness never hands that thread out.
#[test]
fn every_uia_call_is_issued_from_a_thread_that_owns_no_fixture_window() {
    bootstrap();
    let fixture = LocalFixture::create().expect("the fixture window is created");

    let pump = fixture
        .pump_thread_id()
        .expect("the pump thread is running");
    assert_ne!(std::thread::current().id(), pump);

    let root = resolve(fixture.handle());

    assert!(root.0.get_control_type().is_ok());
}

/// The rule A1-2 establishes for a minimized window, not this box's `-32000`
/// literal: minimizing must not truncate the tree, and it degenerates
/// geometry in two different shapes at once - the top level reports an empty
/// rectangle while its descendants keep real extents.
///
/// A14-8 records where this fixture diverges from A1-2 on the COM stack:
/// `IsOffscreen` is not false throughout. The minimized top level reports
/// true while every descendant reports false, so the assertion here is the
/// completeness and geometry rule, never an `IsOffscreen` value.
#[test]
fn minimizing_degenerates_geometry_without_truncating_the_tree() {
    bootstrap();
    let fixture = LocalFixture::create().expect("the fixture window is created");
    let walker = raw_view_walker();
    let restored = descendant_count(&walker, &resolve(fixture.handle()).0, 0);
    assert!(restored > 0, "the fixture exposes child controls");

    fixture.minimize();
    std::thread::sleep(SETTLE);

    let minimized = resolve(fixture.handle());
    assert_eq!(
        descendant_count(&walker, &minimized.0, 0),
        restored,
        "Windows Engineering Invariant 10: a minimized window stays fully walkable"
    );

    let top_level = minimized
        .0
        .get_bounding_rectangle()
        .expect("the top level reports a rectangle");
    assert!(
        is_empty(&top_level),
        "the minimized top level degenerates to an empty rectangle"
    );
    let descendants_with_extent = direct_children(&walker, &minimized.0)
        .iter()
        .filter_map(|child| child.get_bounding_rectangle().ok())
        .filter(|rectangle| !is_empty(rectangle))
        .count();
    assert!(
        descendants_with_extent > 0,
        "an empty top-level rectangle is not the only degenerate shape - descendants keep real extents"
    );
}

fn is_empty(rectangle: &uiautomation::types::Rect) -> bool {
    rectangle.get_right() - rectangle.get_left() == 0
        && rectangle.get_bottom() - rectangle.get_top() == 0
}

/// The fixture must actually be able to demonstrate the secure-field gate
/// before the secure-field gate relies on it: the plain control's text has to be readable, and
/// the password control's text has to be a real secret that a read could
/// leak. A fixture that failed either half would make the secure-field gate untestable.
#[test]
fn the_fixture_exposes_plain_content_and_withholds_secure_content() {
    bootstrap();
    let fixture = HostedFixture::spawn().expect("the fixture host starts");
    let root = resolve(fixture.handle());
    let walker = raw_view_walker();
    let children = direct_children(&walker, &root.0);

    let readable = children
        .iter()
        .filter_map(|child| child.get_property_value(UIProperty::ValueValue).ok())
        .filter_map(|value| value.get_string().ok())
        .any(|value| value.contains(CONTENT_MARKER));
    assert!(
        readable,
        "the fixture's plain control must expose its content, or the gate has nothing to gate"
    );

    let secure = children
        .iter()
        .find(|child| child.is_password().unwrap_or(false))
        .expect("the fixture exposes a control reporting IsPassword");
    for property in [
        UIProperty::ValueValue,
        UIProperty::LegacyIAccessibleValue,
        UIProperty::Name,
        UIProperty::HelpText,
    ] {
        let read = secure
            .get_property_value(property)
            .ok()
            .and_then(|value| value.get_string().ok())
            .unwrap_or_default();
        assert!(
            !read.contains(SECURE_MARKER),
            "a secure control leaked its content through {property:?}"
        );
    }
}

/// Teardown must not depend on the window still existing.
///
/// `WM_CLOSE` reaches the pump only through the window, so a window destroyed
/// out from under the fixture would leave `GetMessageW` blocked and turn the
/// joining `Drop` into a hang of the whole test binary - which on CI burns the
/// lane's timeout and produces no diagnostic at all. The whole lifecycle runs
/// on a helper thread and the test thread waits on it with a deadline, so a
/// regression fails this test by name instead of hanging the binary.
#[test]
fn a_fixture_whose_window_is_already_destroyed_still_tears_down() {
    let (torn_down, report) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let fixture = LocalFixture::create().expect("the fixture window is created");
        let handle = fixture.handle();
        crate::tree::fixture::fixture_window::destroy_window(handle);
        drop(fixture);
        let _ = torn_down.send(());
    });

    match report.recv_timeout(Duration::from_secs(20)) {
        Ok(()) => {}
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            panic!("fixture teardown hung after its window was destroyed")
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            panic!("the teardown thread ended without completing the teardown")
        }
    }
}
