//! The states-completeness predicate's truth table, driven through
//! `live_element` rather than the predicate directly so that a hardcoded
//! `states_complete` cannot keep these cases green.
//!
//! Split from `live_read_tests.rs`, which sits near the per-file line cap:
//! the predicate is a pure function of the read set and the resolved role, so
//! these cases build `LiveRead` values by hand, need no UI Automation client,
//! and run on every target.

use super::{LiveRead, live_element};
use crate::tree::properties::element_properties::ElementProperties;
use crate::tree::properties::property_ids::TreeProperty;
use crate::tree::properties::property_outcome::{PropertyOutcome, PropertyValue};
use agent_desktop_core::{
    IdentifierEvidence, LocatorEvidence, LocatorField, LocatorRefEvidence, NodeDescriptor,
};

fn flag(property: TreeProperty, value: bool) -> (TreeProperty, PropertyOutcome) {
    (property, PropertyOutcome::Known(PropertyValue::Flag(value)))
}

fn number(property: TreeProperty, value: i32) -> (TreeProperty, PropertyOutcome) {
    (
        property,
        PropertyOutcome::Known(PropertyValue::Number(value)),
    )
}

fn unknown(property: TreeProperty) -> (TreeProperty, PropertyOutcome) {
    (property, PropertyOutcome::Unknown)
}

fn absent(property: TreeProperty) -> (TreeProperty, PropertyOutcome) {
    (property, PropertyOutcome::Absent)
}

fn read_with(role: &str, reads: Vec<(TreeProperty, PropertyOutcome)>) -> LiveRead {
    LiveRead {
        properties: ElementProperties::from_reads(reads),
        evidence: LocatorEvidence {
            role: LocatorField::Known(role.to_string()),
            name: LocatorField::Absent,
            description: LocatorField::Absent,
            value: LocatorField::Absent,
            identifiers: IdentifierEvidence::absent(),
            states: LocatorField::Known(Vec::new()),
            ref_evidence: LocatorRefEvidence {
                window_bounds: LocatorField::Absent,
                bounds: LocatorField::Absent,
                available_actions: LocatorField::Known(Vec::new()),
                descriptors: NodeDescriptor::default(),
            },
        },
    }
}

fn complete(role: &str, reads: Vec<(TreeProperty, PropertyOutcome)>) -> bool {
    live_element(&read_with(role, reads))
        .expect("a known role with known actions projects")
        .states_complete
}

#[test]
fn an_expandable_role_with_a_read_expand_state_is_complete() {
    assert!(complete(
        "treeitem",
        vec![
            flag(TreeProperty::ExpandCollapseAvailable, true),
            number(TreeProperty::ExpandCollapseState, 1),
        ],
    ));
}

#[test]
fn an_expandable_role_whose_expand_state_read_failed_is_incomplete() {
    assert!(!complete(
        "treeitem",
        vec![
            flag(TreeProperty::ExpandCollapseAvailable, true),
            unknown(TreeProperty::ExpandCollapseState),
        ],
    ));
}

#[test]
fn an_expandable_role_whose_expand_state_is_absent_is_incomplete() {
    assert!(!complete(
        "combobox",
        vec![
            flag(TreeProperty::ExpandCollapseAvailable, true),
            absent(TreeProperty::ExpandCollapseState),
        ],
    ));
}

#[test]
fn an_expandable_role_without_its_availability_gate_is_incomplete() {
    assert!(!complete(
        "treeitem",
        vec![number(TreeProperty::ExpandCollapseState, 1)],
    ));
}

#[test]
fn a_menuitem_advertising_expand_collapse_with_a_read_state_is_complete() {
    assert!(complete(
        "menuitem",
        vec![
            flag(TreeProperty::ExpandCollapseAvailable, true),
            number(TreeProperty::ExpandCollapseState, 1),
        ],
    ));
}

#[test]
fn a_menuitem_advertising_expand_collapse_whose_state_read_failed_is_incomplete() {
    assert!(!complete(
        "menuitem",
        vec![
            flag(TreeProperty::ExpandCollapseAvailable, true),
            unknown(TreeProperty::ExpandCollapseState),
        ],
    ));
}

#[test]
fn a_menuitem_advertising_expand_collapse_whose_state_is_absent_is_incomplete() {
    assert!(!complete(
        "menuitem",
        vec![
            flag(TreeProperty::ExpandCollapseAvailable, true),
            absent(TreeProperty::ExpandCollapseState),
        ],
    ));
}

#[test]
fn a_menuitem_without_expand_collapse_completes_because_neither_half_applies() {
    assert!(complete(
        "menuitem",
        vec![
            absent(TreeProperty::ExpandCollapseAvailable),
            absent(TreeProperty::ExpandCollapseState),
        ],
    ));
}

#[test]
fn an_expandable_role_without_the_pattern_gate_is_incomplete() {
    assert!(!complete(
        "combobox",
        vec![
            absent(TreeProperty::ExpandCollapseAvailable),
            absent(TreeProperty::ExpandCollapseState),
        ],
    ));
}

#[test]
fn a_toggleable_role_reports_completeness_only_when_toggle_state_was_read() {
    assert!(complete(
        "checkbox",
        vec![
            absent(TreeProperty::ExpandCollapseAvailable),
            flag(TreeProperty::ToggleAvailable, true),
            number(TreeProperty::ToggleState, 1),
        ],
    ));
    assert!(!complete(
        "checkbox",
        vec![
            absent(TreeProperty::ExpandCollapseAvailable),
            flag(TreeProperty::ToggleAvailable, true),
            unknown(TreeProperty::ToggleState),
        ],
    ));
}

#[test]
fn a_role_that_is_neither_toggleable_nor_expandable_is_complete() {
    assert!(complete(
        "button",
        vec![
            absent(TreeProperty::ExpandCollapseAvailable),
            absent(TreeProperty::ToggleState),
            absent(TreeProperty::ExpandCollapseState),
        ],
    ));
}

/// A failed optional availability read must not hold an ordinary control at
/// "never looked": the visibility gate would stay unknown and every action on
/// it would time out.
#[test]
fn a_menuitem_whose_expand_availability_read_failed_is_still_complete() {
    assert!(complete(
        "menuitem",
        vec![
            unknown(TreeProperty::ExpandCollapseAvailable),
            absent(TreeProperty::ExpandCollapseState),
        ],
    ));
}

#[test]
fn a_menuitem_that_answers_no_expand_collapse_is_complete() {
    assert!(complete(
        "menuitem",
        vec![
            flag(TreeProperty::ExpandCollapseAvailable, false),
            absent(TreeProperty::ExpandCollapseState),
        ],
    ));
}

/// A WinForms drop-down list on build 17763 is a `combobox` whose provider
/// answers that it has no `ExpandCollapse` pattern. Demanding an expand state
/// it can never report made every action on it time out at the visibility
/// gate.
#[test]
fn an_expandable_role_whose_provider_answers_no_pattern_is_complete() {
    assert!(complete(
        "combobox",
        vec![
            flag(TreeProperty::ExpandCollapseAvailable, false),
            absent(TreeProperty::ExpandCollapseState),
        ],
    ));
}
