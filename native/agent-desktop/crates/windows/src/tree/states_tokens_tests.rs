use agent_desktop_core::LocatorField;
use agent_desktop_core::tree::state;

use crate::tree::properties::property_ids::TreeProperty;
use crate::tree::properties::{ElementProperties, PropertyOutcome};
use crate::tree::test_support::{flag, number};

use super::resolve_states;

const STATE_SYSTEM_BUSY_BITS: i32 = 0x0000_0800;
const STATE_SYSTEM_HASPOPUP_BITS: i32 = 0x4000_0000;
const STATE_SYSTEM_PRESSED_BITS: i32 = 0x0000_0008;
const TOGGLE_STATE_ON: i32 = 1;
const TOGGLE_STATE_INDETERMINATE: i32 = 2;
const EXPAND_COLLAPSE_EXPANDED: i32 = 1;

/// Resolves one element's tokens with the read-health prerequisite satisfied,
/// so a case here exercises a producer branch rather than the fallback.
///
/// The healthy `IsEnabled` read is **appended**, and only when the case did
/// not state one of its own. `ElementProperties::get` answers with the first
/// entry for a property, so prepending it would shadow a case that reads
/// `IsEnabled` as `false` and silently turn the `disabled` producer's own
/// case into an element that is enabled.
fn tokens(reads: Vec<(TreeProperty, PropertyOutcome)>, role: &str) -> Vec<String> {
    let mut all_reads = reads;
    if !all_reads
        .iter()
        .any(|(property, _)| *property == TreeProperty::IsEnabled)
    {
        all_reads.push(flag(TreeProperty::IsEnabled, true));
    }
    match resolve_states(
        &ElementProperties::from_reads(all_reads),
        &LocatorField::Known(role.to_string()),
    ) {
        LocatorField::Known(states) => states,
        other => panic!("a healthy read must resolve states, got {other:?}"),
    }
}

/// One source, the role it fires on, and the exact token list it must produce.
///
/// The expectation is the whole list rather than a membership test, so a
/// producer branch that stops firing fails at the case that named it and a
/// branch that fires on the wrong input fails at the case it invaded. Asking
/// only whether the emitted tokens belong to the vocabulary answers yes for a
/// producer that emits nothing at all.
struct TokenCase {
    reads: Vec<(TreeProperty, PropertyOutcome)>,
    role: &'static str,
    expected: &'static [&'static str],
}

fn cases() -> Vec<TokenCase> {
    vec![
        TokenCase {
            reads: vec![flag(TreeProperty::IsEnabled, false)],
            role: "button",
            expected: &[state::DISABLED],
        },
        TokenCase {
            reads: vec![flag(TreeProperty::IsPassword, true)],
            role: "textfield",
            expected: &[state::SECURE],
        },
        TokenCase {
            reads: vec![flag(TreeProperty::IsOffscreen, true)],
            role: "button",
            expected: &[state::OFFSCREEN],
        },
        TokenCase {
            reads: vec![flag(TreeProperty::HasKeyboardFocus, true)],
            role: "textfield",
            expected: &[state::FOCUSED],
        },
        TokenCase {
            reads: vec![flag(TreeProperty::IsRequiredForForm, true)],
            role: "textfield",
            expected: &[state::REQUIRED],
        },
        TokenCase {
            reads: vec![
                flag(TreeProperty::ToggleAvailable, true),
                number(TreeProperty::ToggleState, TOGGLE_STATE_ON),
            ],
            role: "checkbox",
            expected: &[state::CHECKED],
        },
        TokenCase {
            reads: vec![
                flag(TreeProperty::ToggleAvailable, true),
                number(TreeProperty::ToggleState, TOGGLE_STATE_INDETERMINATE),
            ],
            role: "checkbox",
            expected: &[state::INDETERMINATE],
        },
        TokenCase {
            reads: vec![
                flag(TreeProperty::ExpandCollapseAvailable, true),
                number(TreeProperty::ExpandCollapseState, EXPAND_COLLAPSE_EXPANDED),
            ],
            role: "treeitem",
            expected: &[state::EXPANDED],
        },
        TokenCase {
            reads: vec![
                flag(TreeProperty::SelectionItemAvailable, true),
                flag(TreeProperty::SelectionItemIsSelected, true),
            ],
            role: "cell",
            expected: &[state::SELECTED],
        },
        TokenCase {
            reads: vec![
                flag(TreeProperty::ValueAvailable, true),
                flag(TreeProperty::ValueIsReadOnly, true),
            ],
            role: "textfield",
            expected: &[state::READONLY],
        },
        TokenCase {
            reads: vec![
                flag(TreeProperty::SelectionAvailable, true),
                flag(TreeProperty::SelectionCanSelectMultiple, true),
            ],
            role: "listbox",
            expected: &[state::MULTISELECTABLE],
        },
        TokenCase {
            reads: vec![
                flag(TreeProperty::WindowAvailable, true),
                flag(TreeProperty::WindowIsModal, true),
            ],
            role: "window",
            expected: &[state::MODAL],
        },
        TokenCase {
            reads: vec![number(
                TreeProperty::LegacyState,
                STATE_SYSTEM_HASPOPUP_BITS,
            )],
            role: "menuitem",
            expected: &[state::HASPOPUP],
        },
        TokenCase {
            reads: vec![number(TreeProperty::LegacyState, STATE_SYSTEM_BUSY_BITS)],
            role: "button",
            expected: &[state::BUSY],
        },
        TokenCase {
            reads: vec![number(TreeProperty::LegacyState, STATE_SYSTEM_PRESSED_BITS)],
            role: "button",
            expected: &[state::PRESSED],
        },
    ]
}

/// Every producer this module ships, pinned to the token it must emit.
///
/// Deleting any one branch fails exactly the case that names it.
#[test]
fn each_source_emits_exactly_the_token_it_is_the_producer_for() {
    for case in cases() {
        assert_eq!(
            tokens(case.reads, case.role),
            case.expected,
            "the {} case",
            case.expected.join("+")
        );
    }
}

/// The table covers every token this producer can emit, so a branch added
/// without a case cannot hide behind the cases already here.
///
/// `hidden` and `invalid` are the vocabulary members with no Windows producer
/// at all - neither has a UI Automation source - so they are named here as
/// deliberately unproduced rather than left to read as an omission. `pressed`
/// is not one of them: `push_legacy_state` emits it for a plain `button` role
/// carrying `STATE_SYSTEM_PRESSED` through `LegacyIAccessibleState`, a
/// different path than the toggle-bearing `switch` reclassification, and its
/// case above is what pins that.
#[test]
fn the_case_table_names_every_token_this_crate_can_produce() {
    const UNPRODUCED: &[&str] = &[state::HIDDEN, state::INVALID];

    let covered: Vec<&str> = cases()
        .iter()
        .flat_map(|case| case.expected.iter().copied())
        .collect();
    assert!(
        !covered.is_empty(),
        "an empty case table would satisfy every assertion in this file"
    );

    let mut produced_by_source: Vec<&str> = Vec::new();
    for token in state::STATE_VOCABULARY {
        if UNPRODUCED.contains(token) {
            assert!(
                !covered.contains(token),
                "{token} is listed as unproduced but a case claims to produce it"
            );
            continue;
        }
        assert!(
            covered.contains(token),
            "{token} is in the vocabulary and is not named unproduced, so a case must pin its producer"
        );
        produced_by_source.push(token);
    }
    assert_eq!(
        produced_by_source.len() + UNPRODUCED.len(),
        state::STATE_VOCABULARY.len()
    );
}

/// The negative direction of the same table: a read that says the source is
/// off produces no token, so a branch that fired unconditionally would fail
/// here rather than passing the positive cases above.
#[test]
fn a_source_read_as_off_produces_no_token() {
    assert!(tokens(vec![flag(TreeProperty::IsPassword, false)], "textfield").is_empty());
    assert!(tokens(vec![flag(TreeProperty::IsOffscreen, false)], "button").is_empty());
    assert!(
        tokens(
            vec![
                flag(TreeProperty::WindowAvailable, true),
                flag(TreeProperty::WindowIsModal, false),
            ],
            "window",
        )
        .is_empty()
    );
    assert!(tokens(vec![number(TreeProperty::LegacyState, 0)], "button").is_empty());
}
