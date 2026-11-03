use super::*;
use crate::tree::properties::property_outcome::PropertyValue;
use crate::tree::test_support::text;

const MARKER: &str = "zzmarkerzz";

/// Builds a read set the way the walk does: every property this module reads
/// is present, because `WALK_SET` always requests all of them and
/// `ElementProperties::get` reports a property nobody requested as `Unknown` -
/// a failed read, not an absent one. A fixture that omitted them would make
/// every name uncertain for a reason the walk never produces.
///
/// Entries the caller supplies win, because `get` returns the first match.
pub(super) fn reads(entries: &[(TreeProperty, PropertyOutcome)]) -> ElementProperties {
    let mut all = entries.to_vec();
    for property in [
        TreeProperty::Name,
        TreeProperty::FullDescription,
        TreeProperty::HelpText,
        TreeProperty::IsPassword,
    ] {
        all.push((property, PropertyOutcome::Absent));
    }
    ElementProperties::from_reads(all)
}

fn name_of(
    entries: &[(TreeProperty, PropertyOutcome)],
    label: &LabelOutcome,
) -> LocatorField<String> {
    name_fields(&reads(entries), label).0
}

fn description_of(
    entries: &[(TreeProperty, PropertyOutcome)],
    label: &LabelOutcome,
) -> LocatorField<String> {
    name_fields(&reads(entries), label).1
}

/// The consumer-visible consequence of the `description_slot` rule, pinned at
/// the boundary rather than only on the helper.
///
/// With nothing else to name the element, the description would have *been*
/// the name. So when its read fails, the honest answer is that the name is
/// `Unknown` - not `Absent`, which satisfies completeness gating and would let
/// an element that never answered pass a requirement it never met.
///
/// The `Absent`/`Absent` control beside it is what makes this falsifiable: a
/// provider that definitively has no description still yields an `Absent`
/// name, so the test cannot pass by making everything `Unknown`.
#[test]
fn a_failed_description_read_clouds_the_name_it_would_have_supplied() {
    let failed = name_of(
        &[
            (TreeProperty::Name, text("")),
            (TreeProperty::FullDescription, PropertyOutcome::Unknown),
            (TreeProperty::HelpText, PropertyOutcome::Absent),
        ],
        &LabelOutcome::Unlabelled,
    );
    let answered = name_of(
        &[
            (TreeProperty::Name, text("")),
            (TreeProperty::FullDescription, PropertyOutcome::Absent),
            (TreeProperty::HelpText, PropertyOutcome::Absent),
        ],
        &LabelOutcome::Unlabelled,
    );

    assert_eq!(
        failed,
        LocatorField::Unknown,
        "a description read that failed was reported as a definitively absent name"
    );
    assert_eq!(
        answered,
        LocatorField::Absent,
        "a provider that has no description must still yield an absent name"
    );
}

#[test]
fn the_provider_computed_name_is_the_name() {
    assert_eq!(
        name_of(
            &[(TreeProperty::Name, text("Save"))],
            &LabelOutcome::Unlabelled
        ),
        LocatorField::Known("Save".into())
    );
}

/// UIA's `Name` is the provider's own *computed* accessible name, which has
/// typically already absorbed the label relationship. A label that outranked
/// it would let a fragment override the name the provider finalised.
#[test]
fn a_label_never_renames_an_element_whose_own_name_is_populated() {
    assert_eq!(
        name_of(
            &[(TreeProperty::Name, text("Save"))],
            &LabelOutcome::Text("Field label".into())
        ),
        LocatorField::Known("Save".into()),
        "the label overrode a name the provider had already computed"
    );
}

/// The case the label slot exists for: `Name` said nothing, so the relation is
/// the only evidence available.
#[test]
fn a_label_supplies_the_name_when_the_element_has_none() {
    assert_eq!(
        name_of(
            &[(TreeProperty::Name, text(""))],
            &LabelOutcome::Text("Field label".into())
        ),
        LocatorField::Known("Field label".into())
    );
}

#[test]
fn an_unlabelled_element_is_absent_rather_than_failed() {
    assert_eq!(
        name_of(
            &[(TreeProperty::Name, PropertyOutcome::Absent)],
            &LabelOutcome::Unlabelled
        ),
        LocatorField::Absent,
        "no label relation is the ordinary case A15-1 measured, not an error"
    );
}

/// The cross-element secure-label case, which A15-2 measured as constructible
/// rather than hypothetical: a WPF TextBox labelled by a PasswordBox resolves,
/// and the target reports IsPassword while the referring element does not.
///
/// The referring element's own gate never sees this, because the text came
/// from a different element. Adding `labelled_by_text` to `VALUE_BEARING`
/// would not close it either - that protects the referring element.
#[test]
fn a_non_secure_element_labelled_by_a_secure_one_yields_no_label_text() {
    let entries = [
        (TreeProperty::Name, text("")),
        (
            TreeProperty::IsPassword,
            PropertyOutcome::Known(PropertyValue::Flag(false)),
        ),
    ];

    assert_eq!(
        name_of(&entries, &LabelOutcome::Withheld),
        LocatorField::Absent,
        "the secure target's text reached the referring element's name"
    );
    assert_eq!(
        name_of(&entries, &LabelOutcome::Text(MARKER.into())),
        LocatorField::Known(MARKER.into()),
        "the same shape with a non-secure target must produce the name, or the case above proves nothing"
    );
}

/// A relation that failed to read is not the same as one that does not exist.
#[test]
fn a_failed_label_read_clouds_the_name_rather_than_reporting_absent() {
    assert_eq!(
        name_of(&[(TreeProperty::Name, text(""))], &LabelOutcome::Failed),
        LocatorField::Unknown
    );
}

#[test]
fn a_failed_name_read_is_unknown_not_absent() {
    assert_eq!(
        name_of(
            &[(TreeProperty::Name, PropertyOutcome::Unknown)],
            &LabelOutcome::Unlabelled
        ),
        LocatorField::Unknown
    );
}

/// `HelpText` occupies exactly one slot, and this test names which: it is the
/// description's fallback, never a second slot of its own.
#[test]
fn help_text_is_the_description_fallback_and_occupies_no_other_slot() {
    assert_eq!(
        description_of(
            &[
                (TreeProperty::Name, text("Save")),
                (TreeProperty::FullDescription, text("Saves the draft")),
                (TreeProperty::HelpText, text("ignored")),
            ],
            &LabelOutcome::Unlabelled
        ),
        LocatorField::Known("Saves the draft".into()),
        "FullDescription is the richer source and wins"
    );
    assert_eq!(
        description_of(
            &[
                (TreeProperty::Name, text("Save")),
                (TreeProperty::FullDescription, text("")),
                (TreeProperty::HelpText, text("Saves the draft")),
            ],
            &LabelOutcome::Unlabelled
        ),
        LocatorField::Known("Saves the draft".into()),
        "HelpText backs it up when FullDescription is blank"
    );
}

/// An element whose only evidence is a description has that description as its
/// name, so reporting it twice would tell a calling agent nothing.
#[test]
fn a_description_alone_becomes_the_name_and_is_not_repeated() {
    let entries = [
        (TreeProperty::Name, text("")),
        (TreeProperty::FullDescription, text("scroll region")),
    ];

    assert_eq!(
        name_of(&entries, &LabelOutcome::Unlabelled),
        LocatorField::Known("scroll region".into())
    );
    assert_eq!(
        description_of(&entries, &LabelOutcome::Unlabelled),
        LocatorField::Absent
    );
}

/// The adapter computes no name of its own: every slot it fills is one core's
/// precedence consumes. The three it cannot fill are suppressed rather than
/// left to look like absent evidence. The placeholder slot is now filled (it
/// is no longer "deliberately unfilled"), but on an element whose
/// `FullDescription` has no text, `HelpText` is the description and the slot is
/// suppressed so the prompt does not double as the description.
#[test]
fn the_adapter_supplies_slots_and_suppresses_the_ones_it_cannot_fill() {
    let status = status_of(
        &reads(&[(TreeProperty::Name, text("Save"))]),
        &LabelOutcome::Unlabelled,
    );

    assert_eq!(status.explicit_label, SlotStatus::Suppressed);
    assert_eq!(status.static_value, SlotStatus::Suppressed);
    assert_eq!(status.child_label, SlotStatus::Suppressed);
    assert_eq!(
        status.placeholder,
        SlotStatus::Suppressed,
        "without a FullDescription, HelpText is the description, so no placeholder is claimed"
    );
}

/// When `FullDescription` carries the description, `HelpText` is free to be
/// the placeholder and the slot is Certain. A placeholder-only control's
/// prompt then reaches the name precedence, which is what lets such a control
/// receive a name at all.
#[test]
fn placeholder_slot_is_certain_when_help_text_is_not_the_description() {
    let status = status_of(
        &reads(&[
            (TreeProperty::FullDescription, text("The description")),
            (TreeProperty::HelpText, text("The prompt")),
        ]),
        &LabelOutcome::Unlabelled,
    );

    assert_eq!(status.placeholder, SlotStatus::Certain);

    let (name, _) = name_fields(
        &reads(&[
            (TreeProperty::FullDescription, text("The description")),
            (TreeProperty::HelpText, text("The prompt")),
        ]),
        &LabelOutcome::Unlabelled,
    );
    assert_eq!(name, LocatorField::Known("The description".into()));
}

/// A failed `HelpText` read on an element with a real description is not a
/// placeholder claim: the slot turns Uncertain so the name precedence knows a
/// placeholder may exist that this read could not surface.
#[test]
fn placeholder_slot_is_uncertain_when_its_source_read_failed() {
    let status = status_of(
        &reads(&[
            (TreeProperty::FullDescription, text("The description")),
            (TreeProperty::HelpText, PropertyOutcome::Unknown),
        ]),
        &LabelOutcome::Unlabelled,
    );

    assert_eq!(status.placeholder, SlotStatus::Uncertain);
}

/// The secure gate is upstream of this module: a secure element's `Name` is
/// already withheld by `ElementProperties`, so no name-evidence slot can carry
/// it. Asserted here with a marker so a future change that reads `Name` around
/// the gate fails loudly.
#[test]
fn secure_content_reaches_no_name_evidence_slot() {
    let entries: Vec<(TreeProperty, PropertyOutcome)> = TreeProperty::VALUE_BEARING
        .iter()
        .map(|property| (*property, text(MARKER)))
        .chain([(
            TreeProperty::IsPassword,
            PropertyOutcome::Known(PropertyValue::Flag(true)),
        )])
        .collect();

    let (name, description) = name_fields(&reads(&entries), &LabelOutcome::Unlabelled);

    for field in [name, description] {
        if let LocatorField::Known(value) = field {
            assert!(
                !value.contains(MARKER),
                "secure content reached a name slot"
            );
        }
    }
}

/// This is the gate itself, not the mapping from an already-decided
/// `LabelOutcome` to no-text. A secure target must never surface its name,
/// regardless of what that name is.
#[test]
fn a_secure_target_withholds_its_name_even_when_the_name_is_readable() {
    assert_eq!(
        label_from_target(true, Ok(MARKER.into())),
        LabelOutcome::Withheld
    );
}

#[test]
fn a_non_secure_target_with_a_readable_name_yields_the_text() {
    assert_eq!(
        label_from_target(false, Ok(MARKER.into())),
        LabelOutcome::Text(MARKER.into())
    );
}

#[test]
fn a_non_secure_target_with_a_blank_name_is_unlabelled() {
    assert_eq!(
        label_from_target(false, Ok("   ".into())),
        LabelOutcome::Unlabelled
    );
}

#[test]
fn a_target_name_read_that_failed_is_reported_as_failed() {
    assert_eq!(label_from_target(false, Err(())), LabelOutcome::Failed);
}

/// Pins the fail-closed policy behind `is_secure`: a target's `IsPassword`
/// that could not be read is not evidence the target is safe, so it is
/// treated the same as a confirmed secure target.
#[test]
fn an_unreadable_is_password_read_is_treated_as_secure() {
    assert!(secure_from_read(Err(())));
    assert!(secure_from_read(Ok(true)));
    assert!(!secure_from_read(Ok(false)));
}
