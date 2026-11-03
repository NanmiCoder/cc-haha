use super::tests::reads;
use super::{SlotStatus, TreeProperty, description_slot};
use crate::tree::properties::property_outcome::PropertyOutcome;
use crate::tree::test_support::text;

#[test]
fn description_slot_is_certain_when_one_source_answered_and_the_other_failed() {
    let properties = reads(&[
        (TreeProperty::FullDescription, text("Saves the draft")),
        (TreeProperty::HelpText, PropertyOutcome::Unknown),
    ]);
    assert_eq!(description_slot(&properties), SlotStatus::Certain);
}

/// The combination that was wrong before the fix: `FullDescription` failed to
/// read and `HelpText` has nothing. The old logic required both sources to be
/// `Unknown` before reporting `Uncertain`, so this came back `Certain` - a
/// failed read reported as a definitive "no description".
#[test]
fn description_slot_is_uncertain_when_one_source_failed_and_the_other_is_merely_absent() {
    let properties = reads(&[
        (TreeProperty::FullDescription, PropertyOutcome::Unknown),
        (TreeProperty::HelpText, PropertyOutcome::Absent),
    ]);
    assert_eq!(description_slot(&properties), SlotStatus::Uncertain);
}

#[test]
fn description_slot_is_uncertain_when_both_sources_failed() {
    let properties = reads(&[
        (TreeProperty::FullDescription, PropertyOutcome::Unknown),
        (TreeProperty::HelpText, PropertyOutcome::Unknown),
    ]);
    assert_eq!(description_slot(&properties), SlotStatus::Uncertain);
}

#[test]
fn description_slot_is_certain_when_both_sources_are_definitively_absent() {
    let properties = reads(&[
        (TreeProperty::FullDescription, PropertyOutcome::Absent),
        (TreeProperty::HelpText, PropertyOutcome::Absent),
    ]);
    assert_eq!(description_slot(&properties), SlotStatus::Certain);
}

/// The measured Win32 shape: `FullDescription` reads back a blank string
/// rather than failing outright, and `HelpText`'s read genuinely failed. A
/// blank `Known("")` is not an answer - `text_of` already treats it the same
/// as no value - so this must cloud the slot exactly as if both reads had
/// failed, not report a definitive "no description" from a source that
/// never actually answered.
#[test]
fn description_slot_is_uncertain_when_one_source_is_blank_and_the_other_failed() {
    let properties = reads(&[
        (TreeProperty::FullDescription, text("")),
        (TreeProperty::HelpText, PropertyOutcome::Unknown),
    ]);
    assert_eq!(description_slot(&properties), SlotStatus::Uncertain);
}

/// Both sources answered, and both answers happen to be blank, with no
/// failed read anywhere. That is a real claim - the provider has no
/// description - and must stay `Certain` rather than being pulled down by
/// the blank-plus-failed rule above.
#[test]
fn description_slot_is_certain_when_both_sources_are_blank_with_no_failed_read() {
    let properties = reads(&[
        (TreeProperty::FullDescription, text("")),
        (TreeProperty::HelpText, text("")),
    ]);
    assert_eq!(description_slot(&properties), SlotStatus::Certain);
}
