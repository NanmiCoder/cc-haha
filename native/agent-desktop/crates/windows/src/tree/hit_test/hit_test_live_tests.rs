use super::hit_test_impl;
use crate::tree::automation::{automation_client, root_from_hwnd};
use crate::tree::element::UIAElement;
use crate::tree::fixture::fixture_overlay;
use crate::tree::fixture::fixture_window;
use crate::tree::fixture::{LocalFixture, ensure_test_apartment};
use crate::tree::walk::walker_fake::deadline;
use agent_desktop_core::{
    AdapterError, Point, Rect, adapter::hit_test::HitTestResult,
    adapter::native_handle::NativeHandle,
};
use std::sync::atomic::{AtomicUsize, Ordering};
use uiautomation::types::Handle;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetWindowRect, HWND_TOPMOST, IsIconic, SWP_SHOWWINDOW, SetWindowPos,
};

/// Pins whose strong assertion is conditioned on Win32 agreeing with itself:
/// `on_screen_fixture_center_reaches_target`,
/// `same_root_overlay_reports_intercepted_by` and
/// `cross_window_overlap_reports_intercepted_and_uncovered_reaches`.
const BRACKETED_PINS: usize = 3;

static PINS_FINISHED: AtomicUsize = AtomicUsize::new(0);
static PINS_ASSERTED: AtomicUsize = AtomicUsize::new(0);

/// Marks that a bracketed pin reached its strong assertion rather than
/// skipping on a contaminated desktop.
fn pin_asserted() {
    PINS_ASSERTED.fetch_add(1, Ordering::SeqCst);
}

/// Ends a bracketed pin. A skip prints to stderr and passes, so a lane where
/// every pin skipped is green yet proves nothing; when the last of the pins
/// in this process finishes with none having asserted, that is a failure.
/// Running a single pin by name, or each test in its own process, never
/// reaches the last-finisher count and so still treats a skip as a pass.
fn finish_pin() {
    let finished = PINS_FINISHED.fetch_add(1, Ordering::SeqCst) + 1;
    assert!(
        finished != BRACKETED_PINS || PINS_ASSERTED.load(Ordering::SeqCst) > 0,
        "every bracketed hit-test pin skipped on a contaminated desktop, so this run proved nothing"
    );
}

/// The window text the fixture gives its overlay child. An interception that
/// names it is the staged occluder; any other name is a window this repository
/// does not own, and the pin it would satisfy is not the one being made.
const OVERLAY_LABEL: &str = "fixture-overlay";

/// A probe together with Win32's independent opinion of the same point, read
/// on both sides of it.
///
/// Reading that opinion only after the probe cannot say which desktop the
/// probe saw. `hit_test` consults `WindowFromPoint` itself while it runs, so a
/// window raised and dropped across the probe leaves the two describing
/// different desktops: the probe reports the occluder it was handed, the later
/// reading attributes the point to the fixture, and the test then asserts an
/// unoccluded verdict against one taken while something was in the way.
/// Agreement between the two readings is the evidence that no such movement
/// happened, and it is what every strong assertion below is conditioned on.
struct BracketedProbe {
    result: HitTestResult,
    before: isize,
    after: isize,
}

impl BracketedProbe {
    /// The window both readings agree owns the point, or `None` when they
    /// disagree and the desktop moved across the probe.
    fn stable_owner(&self) -> Option<isize> {
        (self.before == self.after).then_some(self.after)
    }
}

/// Probes `point` between two independent Win32 readings of that same point.
fn probe_between_win32_readings(handle: &NativeHandle, point: &Point) -> BracketedProbe {
    let before = win32_root_at(point);
    let result = hit_test_impl(handle, point.clone(), deadline()).expect("hit_test succeeds");
    let after = win32_root_at(point);
    BracketedProbe {
        result,
        before,
        after,
    }
}

#[test]
fn on_screen_fixture_center_reaches_target() {
    let _stage = fixture_window::on_screen_stage();
    ensure_test_apartment();
    let (left, top) = fixture_window::on_screen_origin();
    let fixture = LocalFixture::create_at(left, top).expect("on-screen fixture starts");
    fixture_overlay::raise_window(fixture.handle());
    let handle = control_handle(&fixture).expect("button handle");
    let point = center(window_bounds(fixture_window::find_button(fixture.handle())));
    let probe = probe_between_win32_readings(&handle, &point);
    const PIN: &str = "on-screen ReachesTarget";
    match probe.stable_owner() {
        Some(owner) if owner == fixture.handle() => {
            pin_asserted();
            assert_eq!(
                probe.result,
                HitTestResult::ReachesTarget,
                "the window manager gives the point to the fixture, so nothing occludes it"
            );
        }
        Some(owner) => eprintln!("{}", foreign_owner_skip(PIN, owner)),
        None => eprintln!("{}", moved_z_order_skip(PIN, &probe)),
    }
    fixture_overlay::clear_topmost(fixture.handle());
    finish_pin();
}

#[test]
fn minimized_on_screen_fixture_yields_unknown() {
    let _stage = fixture_window::on_screen_stage();
    ensure_test_apartment();
    let (left, top) = fixture_window::on_screen_origin();
    let fixture = LocalFixture::create_at(left, top).expect("on-screen fixture starts");
    let handle = control_handle(&fixture).expect("button handle");
    let point = center(window_bounds(fixture_window::find_button(fixture.handle())));
    fixture.minimize();
    std::thread::sleep(std::time::Duration::from_millis(100));
    assert_ne!(
        unsafe { IsIconic(fixture.handle() as *mut std::ffi::c_void) },
        0,
        "the fixture must be minimized, or Unknown here proves nothing about the iconic guard"
    );
    let result = hit_test_impl(&handle, point, deadline()).expect("hit_test succeeds");
    assert_eq!(result, HitTestResult::Unknown);
}

#[test]
fn same_root_overlay_reports_intercepted_by() {
    let _stage = fixture_window::on_screen_stage();
    ensure_test_apartment();
    let (left, top) = fixture_window::on_screen_origin();
    let fixture = LocalFixture::create_at(left, top).expect("on-screen fixture starts");
    fixture_overlay::raise_window(fixture.handle());
    let handle = control_handle(&fixture).expect("covered button handle");
    let point = center(window_bounds(fixture_window::find_button(fixture.handle())));
    let overlay = fixture_overlay::stage_sibling_overlay(fixture.handle());
    assert!(!overlay.is_null(), "overlay stages over the primary button");
    std::thread::sleep(std::time::Duration::from_millis(50));
    let probe = probe_between_win32_readings(&handle, &point);
    const PIN: &str = "same-root InterceptedBy";
    match probe.stable_owner() {
        Some(owner) if owner == fixture.handle() => {
            pin_asserted();
            assert_names_the_staged_overlay(probe.result);
        }
        Some(owner) => eprintln!("{}", foreign_owner_skip(PIN, owner)),
        None => eprintln!("{}", moved_z_order_skip(PIN, &probe)),
    }
    fixture_overlay::clear_topmost(fixture.handle());
    finish_pin();
}

fn assert_names_the_staged_overlay(result: HitTestResult) {
    match result {
        HitTestResult::InterceptedBy { role, name, .. } => {
            assert!(role.is_some(), "occluder role is always present");
            assert!(
                name.as_deref()
                    .is_some_and(|label| label.contains(OVERLAY_LABEL)),
                "the interception must name the staged fixture overlay, got {name:?}"
            );
        }
        other => panic!("same-root overlay must InterceptedBy, got {other:?}"),
    }
}

#[test]
fn cross_window_overlap_reports_intercepted_and_uncovered_reaches() {
    let _stage = fixture_window::on_screen_stage();
    ensure_test_apartment();
    let (left, top) = fixture_window::on_screen_origin();
    let under = LocalFixture::create_at(left, top).expect("under fixture");
    let (over_left, over_top) = fixture_window::on_screen_origin();
    let over = LocalFixture::create_at(over_left, over_top).expect("over fixture");
    let under_button = fixture_window::find_button(under.handle());
    let covered_bounds = window_bounds(under_button);
    place_topmost(
        over.handle(),
        covered_bounds.x as i32 - 40,
        covered_bounds.y as i32 - 40,
    );
    std::thread::sleep(std::time::Duration::from_millis(80));

    let under_handle = control_handle(&under).expect("under button");
    let covered_point = center(covered_bounds);
    let covered = probe_between_win32_readings(&under_handle, &covered_point);
    match covered.result {
        HitTestResult::InterceptedBy { role, .. } => {
            pin_asserted();
            assert!(role.is_some(), "occluder role is always present");
        }
        HitTestResult::Unknown => {
            report_uncorroborated_cover(&covered, under.handle(), over.handle());
            fixture_overlay::clear_topmost(over.handle());
            finish_pin();
            return;
        }
        other => panic!("cross-window cover must InterceptedBy, got {other:?}"),
    }

    let (clean_left, clean_top) = fixture_window::on_screen_origin();
    place_topmost(over.handle(), clean_left, clean_top);
    std::thread::sleep(std::time::Duration::from_millis(50));
    let over_handle = control_handle(&over).expect("over button");
    let uncovered_point = center(window_bounds(fixture_window::find_button(over.handle())));
    let uncovered = probe_between_win32_readings(&over_handle, &uncovered_point);
    const PIN: &str = "uncovered ReachesTarget (covered InterceptedBy already proven)";
    match uncovered.stable_owner() {
        Some(owner) if owner == over.handle() => {
            pin_asserted();
            assert_eq!(
                uncovered.result,
                HitTestResult::ReachesTarget,
                "the window manager gives the point to the uncovered fixture, so nothing occludes it"
            );
        }
        Some(owner) => eprintln!("{}", foreign_owner_skip(PIN, owner)),
        None => eprintln!("{}", moved_z_order_skip(PIN, &uncovered)),
    }
    fixture_overlay::clear_topmost(over.handle());
    finish_pin();
}

/// Decides whether an uncovered-by-`Unknown` cover is contamination or the
/// regression the pin exists for, and says which.
///
/// Win32 naming the over fixture on *both* sides of the probe is a desktop that
/// held still with the cover genuinely staged, so `Unknown` there is the hit
/// test failing to attribute a window it was handed - a broken root recipe -
/// and must fail the run rather than be excused.
fn report_uncorroborated_cover(covered: &BracketedProbe, under: isize, over: isize) {
    const PIN: &str = "cross-window InterceptedBy";
    match covered.stable_owner() {
        Some(owner) => {
            assert_ne!(
                owner, over,
                "Win32 independently names the over fixture at the covered point on both sides of the probe, so Unknown is a hit-test regression and not z-order contamination"
            );
            if owner == under {
                eprintln!(
                    "skip {PIN}: Win32 still names the under fixture at the covered point, so the overlap never staged"
                );
            } else {
                eprintln!("{}", foreign_owner_skip(PIN, owner));
            }
        }
        None => eprintln!("{}", moved_z_order_skip(PIN, covered)),
    }
}

/// The point a click would land on, which is where every probe here aims.
fn center(bounds: Rect) -> Point {
    Point {
        x: bounds.x + bounds.width / 2.0,
        y: bounds.y + bounds.height / 2.0,
    }
}

/// Moves a fixture window to `left`/`top` above every non-topmost window,
/// keeping the extent the fixture was created with.
fn place_topmost(handle: isize, left: i32, top: i32) {
    unsafe {
        SetWindowPos(
            handle as *mut std::ffi::c_void,
            HWND_TOPMOST,
            left,
            top,
            fixture_window::WINDOW_WIDTH,
            fixture_window::WINDOW_HEIGHT,
            SWP_SHOWWINDOW,
        );
    }
}

/// The independent second opinion, read by the test rather than taken from the
/// code under test: a soft skip is only honest when something outside
/// `hit_test` agrees the point belongs to a window this repository does not own.
fn win32_root_at(point: &Point) -> isize {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GA_ROOT, GetAncestor, WindowFromPoint};

    let physical = POINT {
        x: point.x as i32,
        y: point.y as i32,
    };
    let hwnd = unsafe { WindowFromPoint(physical) };
    if hwnd.is_null() {
        return 0;
    }
    unsafe { GetAncestor(hwnd, GA_ROOT) as isize }
}

fn foreign_owner_skip(pin: &str, owner: isize) -> String {
    format!(
        "skip {pin}: Win32 names window {owner:#x} at the point on both sides of the probe, which is no fixture of this repository — foreign z-order contamination"
    )
}

fn moved_z_order_skip(pin: &str, probe: &BracketedProbe) -> String {
    format!(
        "skip {pin}: Win32 names window {:#x} at the point before the probe and {:#x} after it, so the z-order moved across the probe and the two opinions describe different desktops",
        probe.before, probe.after
    )
}

fn control_handle(fixture: &LocalFixture) -> Result<NativeHandle, AdapterError> {
    let _ = root_from_hwnd(fixture.handle(), deadline())?;
    let button = fixture_window::find_button(fixture.handle());
    assert!(!button.is_null(), "fixture exposes a BUTTON");
    let client = automation_client()?;
    let element = client
        .element_from_handle(Handle::from(button as isize))
        .map_err(|error| {
            crate::tree::automation::uia_error(&error, "resolve the fixture button")
        })?;
    Ok(UIAElement::from(element).into_native_handle())
}

fn window_bounds(hwnd: *mut std::ffi::c_void) -> Rect {
    let mut rect = windows_sys::Win32::Foundation::RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    unsafe { GetWindowRect(hwnd, &mut rect) };
    Rect {
        x: f64::from(rect.left),
        y: f64::from(rect.top),
        width: f64::from(rect.right - rect.left),
        height: f64::from(rect.bottom - rect.top),
    }
}
