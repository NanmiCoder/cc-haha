use super::{descriptors, placeholder_of};
use crate::tree::properties::ElementProperties;
use crate::tree::properties::property_ids::TreeProperty;
use crate::tree::properties::property_outcome::{PropertyOutcome, PropertyValue};
use crate::tree::test_support::text;

fn from_reads(reads: &[(TreeProperty, PropertyOutcome)]) -> ElementProperties {
    ElementProperties::from_reads(reads.to_vec())
}

/// A node with no descriptor sources produces an all-absent group: every slot
/// is None and `dom_classes` is empty. `dom_classes` has no producer on the
/// pinned stack, so it stays empty for any read set.
#[test]
fn no_sources_produce_an_empty_descriptor_group() {
    let properties = from_reads(&[]);
    let descriptors = descriptors(&properties);

    assert_eq!(descriptors.subrole, None);
    assert_eq!(descriptors.role_description, None);
    assert_eq!(descriptors.placeholder, None);
    assert!(descriptors.dom_classes.is_empty());
}

/// `role_description` is produced from `LocalizedControlType`'s display text.
#[test]
fn role_description_uses_localized_control_type_text() {
    let properties = from_reads(&[(TreeProperty::LocalizedControlType, text("Push button"))]);

    let descriptors = descriptors(&properties);

    assert_eq!(descriptors.role_description.as_deref(), Some("Push button"));
    assert_eq!(descriptors.subrole, None);
}

/// A failed `LocalizedControlType` read produces no `role_description`:
/// `Unknown` is not an empty claim (the eager-state rule from the vocabulary
/// measurements).
#[test]
fn failed_localized_control_type_read_produces_nothing() {
    let properties = from_reads(&[(TreeProperty::LocalizedControlType, PropertyOutcome::Unknown)]);

    let descriptors = descriptors(&properties);

    assert_eq!(descriptors.role_description, None);
}

/// An `Absent` (provider says no such property) also produces nothing.
#[test]
fn absent_localized_control_type_read_produces_nothing() {
    let properties = from_reads(&[(TreeProperty::LocalizedControlType, PropertyOutcome::Absent)]);

    assert_eq!(descriptors(&properties).role_description, None);
}

/// `subrole` is produced only from a non-empty `AriaRole` claim; a failed or
/// empty read contributes nothing.
#[test]
fn subrole_emits_only_on_a_non_empty_aria_role_claim() {
    let present = from_reads(&[(TreeProperty::AriaRole, text("tab"))]);
    assert_eq!(descriptors(&present).subrole.as_deref(), Some("tab"));

    let failed = from_reads(&[(TreeProperty::AriaRole, PropertyOutcome::Unknown)]);
    assert_eq!(descriptors(&failed).subrole, None);

    let blank = from_reads(&[(TreeProperty::AriaRole, text(""))]);
    assert_eq!(descriptors(&blank).subrole, None);
}

/// `placeholder` fills `HelpText` when `FullDescription` is not the
/// description; when `FullDescription` has text, the richer source wins the
/// description slot and `HelpText` is free to be the placeholder.
#[test]
fn placeholder_fills_help_text_when_not_the_description() {
    let properties = from_reads(&[
        (TreeProperty::FullDescription, text("Full description")),
        (TreeProperty::HelpText, text("Type here")),
    ]);

    let descriptors = descriptors(&properties);

    assert_eq!(
        descriptors.placeholder.as_deref(),
        Some("Type here"),
        "HelpText is the placeholder when FullDescription is the description"
    );
}

/// When `FullDescription` is blank, `HelpText` backs up the description and is
/// therefore not a placeholder — the same string must not be reported twice.
#[test]
fn placeholder_stays_absent_when_help_text_is_the_description() {
    let properties = from_reads(&[
        (TreeProperty::FullDescription, text("")),
        (TreeProperty::HelpText, text("Brief hint")),
    ]);

    let descriptors = descriptors(&properties);

    assert_eq!(
        descriptors.placeholder, None,
        "HelpText is the description, not a placeholder, when FullDescription is blank"
    );
}

/// A failed `FullDescription` read leaves `HelpText` as the description, so no
/// placeholder is produced either.
#[test]
fn placeholder_absent_when_description_source_failed() {
    let properties = from_reads(&[
        (TreeProperty::FullDescription, PropertyOutcome::Unknown),
        (TreeProperty::HelpText, text("Brief hint")),
    ]);

    assert_eq!(descriptors(&properties).placeholder, None);
}

/// The secure gate reaches the descriptor sources: a secure element's
/// `HelpText` (value-bearing) is withheld, so a password field's prompt never
/// leaks out as a placeholder, and an `AriaRole`/`LocalizedControlType`
/// (non-value-bearing vocabulary) survives the gate to stay on the element.
#[test]
fn secure_elements_withhold_value_bearing_placeholder_sources() {
    let properties = from_reads(&[
        (
            TreeProperty::IsPassword,
            PropertyOutcome::Known(PropertyValue::Flag(true)),
        ),
        (TreeProperty::FullDescription, text("Full description")),
        (TreeProperty::HelpText, text("secret hint")),
        (TreeProperty::AriaRole, text("textbox")),
    ]);

    assert!(properties.is_secure());
    let descriptors = descriptors(&properties);

    assert_eq!(
        descriptors.placeholder, None,
        "HelpText is value-bearing and must be withheld on a secure element"
    );
    assert_eq!(
        descriptors.subrole.as_deref(),
        Some("textbox"),
        "AriaRole is provider vocabulary, not target text, and survives the gate"
    );
}

/// The standalone `placeholder_of` helper agrees with the group producer.
///
/// The agreement is asserted against `descriptors()` itself rather than
/// against a literal restated in both places, so a group producer that stopped
/// calling the helper - filling the slot from its own rule - fails here.
#[test]
fn placeholder_of_matches_the_group_producer() {
    let properties = from_reads(&[
        (TreeProperty::FullDescription, text("Description")),
        (TreeProperty::HelpText, text("Prompt")),
    ]);

    assert_eq!(placeholder_of(&properties).as_deref(), Some("Prompt"));
    assert_eq!(
        descriptors(&properties).placeholder,
        placeholder_of(&properties),
        "the group producer fills its placeholder slot from the standalone rule"
    );

    let doubling = from_reads(&[(TreeProperty::HelpText, text("Prompt"))]);

    assert_eq!(
        placeholder_of(&doubling),
        None,
        "with no description of its own, HelpText is the description and cannot also be the placeholder"
    );
    assert_eq!(
        descriptors(&doubling).placeholder,
        placeholder_of(&doubling),
        "the group producer withholds it too, rather than reading HelpText directly"
    );
}
