//! The inventory's pure decision rules: what a failed probe costs, and what
//! it must not cost.
//!
//! Split from `surface_inventory_tests.rs`, which drives live fixtures. These
//! cases need no desktop at all - they feed the two probes' own `Result`s to
//! the fold and read the verdict back - so they run everywhere the crate
//! compiles and stay legible next to each other.

use super::{ObservedWindow, inventory_with_menu, modal_classification, surfaces_of};
use agent_desktop_core::{AdapterError, ErrorCode, ProcessId};

fn window(handle: usize, sheet: Result<bool, AdapterError>) -> ObservedWindow {
    ObservedWindow {
        handle: handle as crate::system::window::window_enum::WindowHandle,
        title: Some(format!("window {handle}")),
        foreground: false,
        sheet,
    }
}

fn unreadable() -> Result<bool, AdapterError> {
    Err(AdapterError::new(
        ErrorCode::AppUnresponsive,
        "the window's UIA root could not be read",
    ))
}

fn kinds(surfaces: &[agent_desktop_core::SurfaceInfo]) -> Vec<&str> {
    surfaces.iter().map(|s| s.kind.as_str()).collect()
}

/// One unreadable window used to discard every surface already collected
/// for the process, so a single hung window erased its responsive siblings.
/// It costs that window its sheet classification and nothing else now.
#[test]
fn one_unreadable_window_does_not_erase_the_windows_beside_it() {
    let surfaces = surfaces_of(vec![
        window(1, Ok(false)),
        window(2, unreadable()),
        window(3, Ok(true)),
    ]);

    assert_eq!(
        kinds(&surfaces),
        vec!["window", "window", "window", "sheet"]
    );
    assert!(
        surfaces.iter().any(|s| s.id == "w-3" && s.kind == "sheet"),
        "the third window's sheet survives the second window's failed probe"
    );
    let unclassified = |id: &str| {
        surfaces
            .iter()
            .find(|s| s.id == id && s.kind == "window")
            .map(|s| s.unclassified.clone())
    };
    assert_eq!(unclassified("w-2"), Some(vec!["sheet".to_string()]));
    assert_eq!(unclassified("w-1"), Some(Vec::new()));
    assert_eq!(unclassified("w-3"), Some(Vec::new()));
}

#[test]
fn every_window_failing_still_reports_the_window_level_surfaces() {
    let surfaces = surfaces_of(vec![window(1, unreadable()), window(2, unreadable())]);

    assert_eq!(kinds(&surfaces), vec!["window", "window"]);
}

/// The other direction, which is what makes the case above a claim: a
/// process with no windows is still an empty inventory, and that empty is a
/// different fact from a partial one.
#[test]
fn a_process_with_no_windows_reports_an_empty_inventory() {
    assert!(surfaces_of(Vec::new()).is_empty());
}

#[test]
fn a_foreground_window_keeps_its_focused_surface_beside_a_failed_probe() {
    let mut foreground = window(7, unreadable());
    foreground.foreground = true;

    assert_eq!(
        kinds(&surfaces_of(vec![foreground])),
        vec!["window", "focused"]
    );
}

fn pid() -> ProcessId {
    ProcessId::from(4321_u32)
}

fn probe_failed(code: ErrorCode) -> Result<Option<()>, AdapterError> {
    Err(AdapterError::new(code, "the menu probe could not be run"))
}

/// A menu detector that faulted used to discard every window surface
/// already collected for the process, so one unreadable menu probe erased
/// a process's whole inventory. It costs the process its menu
/// classification and nothing else now.
#[test]
fn a_faulted_menu_probe_leaves_the_window_surfaces_standing() {
    let (surfaces, menu) = inventory_with_menu(
        vec![window(1, Ok(false)), window(2, Ok(true))],
        pid(),
        probe_failed(ErrorCode::AppUnresponsive),
    )
    .expect("a faulted menu probe does not refuse the listing");

    assert!(menu.is_none(), "no menu was located");
    assert_eq!(kinds(&surfaces), vec!["window", "window", "sheet"]);
    for entry in surfaces.iter().filter(|s| s.kind == "window") {
        assert_eq!(entry.unclassified, vec!["menu".to_string()]);
    }
}

/// The other direction, and the reason the fold is not a blanket degrade:
/// a probe that ran out of budget never established that no menu is open,
/// so answering an inventory with no menu in it would be the same
/// fault-as-absence collapse one step further along.
#[test]
fn an_exhausted_budget_is_not_an_inventory_without_a_menu() {
    let error = inventory_with_menu(
        vec![window(1, Ok(false))],
        pid(),
        probe_failed(ErrorCode::Timeout),
    )
    .expect_err("a budget exhaustion refuses the listing");

    assert_eq!(error.code, ErrorCode::Timeout);
}

/// A process that died mid-listing makes the window surfaces already
/// collected statements about a process that is gone, so the refusal
/// keeps its own code rather than degrading to a menu-less inventory.
#[test]
fn a_process_that_died_mid_listing_refuses_the_listing() {
    let error = inventory_with_menu(
        vec![window(1, Ok(false))],
        pid(),
        probe_failed(ErrorCode::AppNotFound),
    )
    .expect_err("a dead process refuses the listing");

    assert_eq!(error.code, ErrorCode::AppNotFound);
}

/// A completed probe that found nothing is an absence, and it must not be
/// confused with either of the arms above.
#[test]
fn a_completed_probe_that_found_no_menu_is_an_absence() {
    let (surfaces, menu) = inventory_with_menu(
        vec![window(1, Ok(false))],
        pid(),
        Ok::<Option<()>, AdapterError>(None),
    )
    .expect("a completed probe does not refuse the listing");

    assert!(menu.is_none());
    assert_eq!(kinds(&surfaces), vec!["window"]);
    assert!(surfaces[0].unclassified.is_empty());
}

#[test]
fn a_located_menu_is_carried_back_to_the_caller() {
    let (_, menu) = inventory_with_menu(Vec::new(), pid(), Ok::<Option<u8>, AdapterError>(Some(7)))
        .expect("a located menu does not refuse the listing");

    assert_eq!(menu, Some(7));
}

#[test]
fn a_failed_modal_read_is_unclassified_while_absent_and_known_classify() {
    use crate::tree::properties::property_outcome::{PropertyOutcome, PropertyValue};

    assert!(modal_classification(PropertyOutcome::Unknown).is_err());
    assert!(!modal_classification(PropertyOutcome::Absent).unwrap());
    assert!(modal_classification(PropertyOutcome::Known(PropertyValue::Flag(true))).unwrap());
    assert!(!modal_classification(PropertyOutcome::Known(PropertyValue::Flag(false))).unwrap());
}
