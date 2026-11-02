use super::*;
use agent_desktop_core::refs::ref_alloc::is_ref_able_role_actions;

use crate::tree::properties::property_outcome::PropertyValue;

fn known_flag(value: bool) -> PropertyOutcome {
    PropertyOutcome::Known(PropertyValue::Flag(value))
}

fn known_text(value: &str) -> PropertyOutcome {
    PropertyOutcome::Known(PropertyValue::Text(value.to_string()))
}

/// A read set with every affordance-bearing pattern reporting `false` or
/// absent, and no keyboard focusability - the shape an inert static text
/// element reads as once `LegacyAvailable` is excluded as an affordance.
fn inert_reads() -> Vec<(TreeProperty, PropertyOutcome)> {
    vec![
        (TreeProperty::InvokeAvailable, known_flag(false)),
        (TreeProperty::ToggleAvailable, known_flag(false)),
        (TreeProperty::ExpandCollapseAvailable, known_flag(false)),
        (TreeProperty::SelectionItemAvailable, known_flag(false)),
        (TreeProperty::ValueAvailable, known_flag(false)),
        (TreeProperty::RangeValueAvailable, known_flag(false)),
        (TreeProperty::ScrollAvailable, known_flag(false)),
        (TreeProperty::ScrollItemAvailable, known_flag(false)),
        (TreeProperty::IsKeyboardFocusable, known_flag(false)),
        (TreeProperty::LegacyDefaultAction, PropertyOutcome::Absent),
    ]
}

fn known_actions(field: &LocatorField<Vec<String>>) -> &[String] {
    field.known().map(Vec::as_slice).unwrap_or(&[])
}

/// The affordance-gating rule's central claim, and the one invisible to any
/// per-pattern test: A2-2 measured `IsLegacyIAccessiblePatternAvailable`
/// `true` on 141 of 141 elements, so an ordinary, non-interactive element
/// that merely advertises `LegacyAvailable` (with no `LegacyDefaultAction`)
/// must not read as ref-able. Making the `LegacyIAccessible` arm
/// unconditional was verified by hand to fail this exact assertion.
#[test]
fn legacy_availability_alone_does_not_make_an_ordinary_element_ref_able() {
    let mut reads = inert_reads();
    reads.push((TreeProperty::LegacyAvailable, known_flag(true)));
    let properties = ElementProperties::from_reads(reads);

    let actions = resolve_actions(&properties);

    assert!(matches!(actions, LocatorField::Known(ref v) if v.is_empty()));
    assert!(!is_ref_able_role_actions(
        "statictext",
        known_actions(&actions)
    ));
}

#[test]
fn invoke_availability_produces_click_and_is_ref_able() {
    let properties =
        ElementProperties::from_reads(vec![(TreeProperty::InvokeAvailable, known_flag(true))]);

    let actions = resolve_actions(&properties);

    assert_eq!(known_actions(&actions), &[capability::CLICK.to_string()]);
    assert!(is_ref_able_role_actions("button", known_actions(&actions)));
}

#[test]
fn no_affordance_bearing_pattern_produces_known_empty_not_unknown() {
    let properties = ElementProperties::from_reads(inert_reads());

    let actions = resolve_actions(&properties);

    assert!(matches!(actions, LocatorField::Known(ref v) if v.is_empty()));
}

#[test]
fn a_failed_availability_read_produces_unknown_not_known_empty() {
    let properties = ElementProperties::from_reads(vec![]);

    let actions = resolve_actions(&properties);

    assert!(matches!(actions, LocatorField::Unknown));
}

#[test]
fn keyboard_focusable_alone_produces_only_set_focus_and_is_not_ref_able() {
    let mut reads = inert_reads();
    reads.retain(|(property, _)| *property != TreeProperty::IsKeyboardFocusable);
    reads.push((TreeProperty::IsKeyboardFocusable, known_flag(true)));
    let properties = ElementProperties::from_reads(reads);

    let actions = resolve_actions(&properties);

    assert_eq!(
        known_actions(&actions),
        &[capability::SET_FOCUS.to_string()]
    );
    assert!(!is_ref_able_role_actions("group", known_actions(&actions)));
}

/// Every emitted action name must be a member of core's own capability
/// vocabulary - checked against the constants core exports, not against a
/// list re-typed in this crate.
#[test]
fn every_emitted_action_is_a_member_of_core_capability_vocabulary() {
    let vocabulary = [
        capability::CLICK,
        capability::RIGHT_CLICK,
        capability::SET_VALUE,
        capability::SET_FOCUS,
        capability::EXPAND,
        capability::COLLAPSE,
        capability::SELECT,
        capability::TOGGLE,
        capability::SCROLL,
        capability::SCROLL_TO,
        capability::PRESS_KEY,
        capability::KEY_DOWN,
        capability::KEY_UP,
        capability::TYPE_TEXT,
        capability::HOVER,
        capability::DRAG,
        capability::CHECK,
        capability::UNCHECK,
    ];
    let properties = ElementProperties::from_reads(vec![
        (TreeProperty::InvokeAvailable, known_flag(true)),
        (TreeProperty::ToggleAvailable, known_flag(true)),
        (TreeProperty::ExpandCollapseAvailable, known_flag(true)),
        (TreeProperty::SelectionItemAvailable, known_flag(true)),
        (TreeProperty::ValueAvailable, known_flag(true)),
        (TreeProperty::ValueIsReadOnly, known_flag(false)),
        (TreeProperty::RangeValueAvailable, known_flag(true)),
        (TreeProperty::ScrollAvailable, known_flag(true)),
        (TreeProperty::ScrollItemAvailable, known_flag(true)),
        (TreeProperty::IsKeyboardFocusable, known_flag(true)),
        (TreeProperty::LegacyAvailable, known_flag(true)),
        (TreeProperty::LegacyDefaultAction, known_text("Press")),
    ]);

    let actions = resolve_actions(&properties);

    for action in known_actions(&actions) {
        assert!(
            vocabulary.contains(&action.as_str()),
            "{action} is not in core's capability vocabulary"
        );
    }

    assert_eq!(
        known_actions(&actions),
        &[
            capability::CLICK.to_string(),
            capability::TOGGLE.to_string(),
            capability::EXPAND.to_string(),
            capability::COLLAPSE.to_string(),
            capability::SELECT.to_string(),
            capability::SET_VALUE.to_string(),
            capability::SCROLL.to_string(),
            capability::SCROLL_TO.to_string(),
            capability::SET_FOCUS.to_string(),
        ],
        "the answer for an all-patterns-available read is exact, in emission order"
    );

    for unreachable in [
        capability::RIGHT_CLICK,
        capability::PRESS_KEY,
        capability::KEY_DOWN,
        capability::KEY_UP,
        capability::TYPE_TEXT,
        capability::HOVER,
        capability::DRAG,
        capability::CHECK,
        capability::UNCHECK,
    ] {
        assert!(
            !known_actions(&actions)
                .iter()
                .any(|action| action == unreachable),
            "{unreachable} is in the vocabulary but this producer cannot emit it, so advertising it would promise an affordance the adapter cannot perform"
        );
    }

    let isolated_cases: [(TreeProperty, &[&str]); 3] = [
        (TreeProperty::ToggleAvailable, &[capability::TOGGLE]),
        (
            TreeProperty::ExpandCollapseAvailable,
            &[capability::EXPAND, capability::COLLAPSE],
        ),
        (TreeProperty::SelectionItemAvailable, &[capability::SELECT]),
    ];
    for (property, expected) in isolated_cases {
        let mut reads = inert_reads();
        reads.retain(|(candidate, _)| *candidate != property);
        reads.push((property, known_flag(true)));
        let isolated = resolve_actions(&ElementProperties::from_reads(reads));
        for action in expected {
            assert!(
                known_actions(&isolated).contains(&action.to_string()),
                "{action} must be advertised when only its own pattern is available"
            );
        }
    }
}

#[test]
fn read_only_value_availability_produces_no_value_setting_action() {
    let mut reads = inert_reads();
    reads.retain(|(property, _)| *property != TreeProperty::ValueAvailable);
    reads.push((TreeProperty::ValueAvailable, known_flag(true)));
    reads.push((TreeProperty::ValueIsReadOnly, known_flag(true)));
    let properties = ElementProperties::from_reads(reads);

    let actions = resolve_actions(&properties);

    assert!(!known_actions(&actions).contains(&capability::SET_VALUE.to_string()));
}

#[test]
fn writable_value_availability_produces_set_value() {
    let mut reads = inert_reads();
    reads.retain(|(property, _)| *property != TreeProperty::ValueAvailable);
    reads.push((TreeProperty::ValueAvailable, known_flag(true)));
    reads.push((TreeProperty::ValueIsReadOnly, known_flag(false)));
    let properties = ElementProperties::from_reads(reads);

    let actions = resolve_actions(&properties);

    assert!(known_actions(&actions).contains(&capability::SET_VALUE.to_string()));
}

#[test]
fn a_failed_read_only_read_produces_no_value_setting_action() {
    let mut reads = inert_reads();
    reads.retain(|(property, _)| *property != TreeProperty::ValueAvailable);
    reads.push((TreeProperty::ValueAvailable, known_flag(true)));
    reads.push((TreeProperty::ValueIsReadOnly, PropertyOutcome::Unknown));
    let properties = ElementProperties::from_reads(reads);

    let actions = resolve_actions(&properties);

    assert!(!known_actions(&actions).contains(&capability::SET_VALUE.to_string()));

    let mut positive_reads = inert_reads();
    positive_reads.retain(|(property, _)| *property != TreeProperty::ValueAvailable);
    positive_reads.push((TreeProperty::ValueAvailable, known_flag(true)));
    positive_reads.push((TreeProperty::ValueIsReadOnly, known_flag(false)));
    let positive_properties = ElementProperties::from_reads(positive_reads);

    let positive_actions = resolve_actions(&positive_properties);

    assert!(known_actions(&positive_actions).contains(&capability::SET_VALUE.to_string()));
}

#[test]
fn legacy_availability_with_a_non_empty_default_action_contributes_click() {
    let mut reads = inert_reads();
    reads.retain(|(property, _)| *property != TreeProperty::LegacyDefaultAction);
    reads.push((TreeProperty::LegacyAvailable, known_flag(true)));
    reads.push((TreeProperty::LegacyDefaultAction, known_text("Press")));
    let properties = ElementProperties::from_reads(reads);

    let actions = resolve_actions(&properties);

    assert!(known_actions(&actions).contains(&capability::CLICK.to_string()));
}

fn range_reads(read_only: Option<bool>) -> Vec<(TreeProperty, PropertyOutcome)> {
    let mut reads = inert_reads();
    reads.retain(|(property, _)| *property != TreeProperty::RangeValueAvailable);
    reads.push((TreeProperty::RangeValueAvailable, known_flag(true)));
    match read_only {
        Some(flag) => reads.push((TreeProperty::RangeValueIsReadOnly, known_flag(flag))),
        None => reads.push((TreeProperty::RangeValueIsReadOnly, PropertyOutcome::Unknown)),
    }
    reads
}

fn advertises_set_value(read_only: Option<bool>) -> bool {
    let properties = ElementProperties::from_reads(range_reads(read_only));
    known_actions(&resolve_actions(&properties))
        .iter()
        .any(|action| action == capability::SET_VALUE)
}

/// The `ValueAvailable` arm has always been gated on its read-only companion;
/// the `RangeValue` arm was not, so a read-only range control was advertised
/// with an action that fails at execution - and a ref was allocated on it.
#[test]
fn a_writable_range_control_advertises_set_value() {
    assert!(advertises_set_value(Some(false)));
}

#[test]
fn a_read_only_range_control_does_not_advertise_set_value() {
    assert!(!advertises_set_value(Some(true)));
}

/// A15-7 measured pattern-state properties returning a default-looking value
/// rather than a not-supported sentinel, so an unreadable read-only flag must
/// fail closed here. Negating a boolean-flavoured predicate would fail open
/// instead, which is the shape recorded in the tri-state learning.
#[test]
fn a_range_control_whose_read_only_flag_is_unreadable_fails_closed() {
    assert!(!advertises_set_value(None));
}
