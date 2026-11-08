use super::*;

fn evidence() -> NameEvidence {
    NameEvidence {
        explicit_label: Some("explicit".into()),
        labelled_by_text: Some("labelled".into()),
        native_title: Some("title".into()),
        static_value: Some("value".into()),
        child_label: Some("child".into()),
        placeholder: Some("placeholder".into()),
        description: Some("description".into()),
    }
}

fn uncertain(slot: SlotStatus) -> NameSlotStatus {
    NameSlotStatus {
        native_title: slot,
        ..NameSlotStatus::default()
    }
}

/// The order asserted here is the one that has produced every snapshot this
/// product has ever emitted. It was not the order this module documented:
/// `description` ranked last here and fifth in the adapter that actually ran,
/// and the documented version had no caller to notice. The shipped order won,
/// and this test is what pins the two together.
#[test]
fn name_precedence_is_the_shipped_order_and_is_complete() {
    let mut value = evidence();
    assert_eq!(compute_name(&value).as_deref(), Some("explicit"));
    value.explicit_label = None;
    assert_eq!(compute_name(&value).as_deref(), Some("labelled"));
    value.labelled_by_text = None;
    assert_eq!(compute_name(&value).as_deref(), Some("title"));
    value.native_title = None;
    assert_eq!(compute_name(&value).as_deref(), Some("value"));
    value.static_value = None;
    assert_eq!(compute_name(&value).as_deref(), Some("description"));
    value.description = None;
    assert_eq!(compute_name(&value).as_deref(), Some("child"));
    value.child_label = None;
    assert_eq!(compute_name(&value).as_deref(), Some("placeholder"));
}

/// The behaviour an `Option`-returning precedence structurally cannot express.
/// A weaker source has a value, but the source that would have outranked it
/// failed to read - so the honest answer is that the name is not known, not
/// that it is the weaker one.
#[test]
fn a_failed_stronger_source_clouds_a_weaker_one_that_did_read() {
    let value = NameEvidence {
        child_label: Some("child".into()),
        ..NameEvidence::default()
    };

    assert_eq!(
        resolve_name(&value, &NameSlotStatus::default()),
        LocatorField::Known("child".into())
    );
    assert_eq!(
        resolve_name(&value, &uncertain(SlotStatus::Uncertain)),
        LocatorField::Unknown
    );
}

/// A suppressed slot is not a failed one: the platform is saying the slot does
/// not apply to this element, which contributes neither a value nor doubt.
/// Conflating the two would make every role that does not use a slot lose its
/// name whenever that slot's read happened to fail.
#[test]
fn a_suppressed_slot_contributes_neither_a_value_nor_uncertainty() {
    let value = NameEvidence {
        native_title: Some("Save".into()),
        child_label: Some("child".into()),
        ..NameEvidence::default()
    };

    assert_eq!(
        resolve_name(&value, &uncertain(SlotStatus::Suppressed)),
        LocatorField::Known("child".into()),
        "the suppressed slot is skipped entirely, value and all"
    );
}

#[test]
fn nothing_readable_and_nothing_failed_is_absent_rather_than_unknown() {
    assert_eq!(
        resolve_name(&NameEvidence::default(), &NameSlotStatus::default()),
        LocatorField::Absent
    );
    assert_eq!(
        resolve_name(&NameEvidence::default(), &uncertain(SlotStatus::Uncertain)),
        LocatorField::Unknown
    );
}

/// A failed description read is `Absent` rather than `Unknown` when nothing
/// outranks the description, and that is deliberate.
///
/// With no stronger source, the description *becomes the name* - the rule
/// `description_is_not_duplicated_when_it_supplies_the_name` pins - so the
/// description field is `Absent` whether the read succeeded or failed: either
/// way there is no *separate* description to report. `Unknown` here would
/// claim a description might exist that provably could not.
///
/// The name is still `Unknown` in that case, which is where the uncertainty
/// belongs. The two answers are asserted together because it is their
/// combination that is correct, and reading either alone invites "fixing" it.
#[test]
fn a_failed_description_is_absent_when_it_would_have_been_the_name() {
    let status = NameSlotStatus {
        description: SlotStatus::Uncertain,
        ..NameSlotStatus::default()
    };

    for evidence in [
        NameEvidence::default(),
        NameEvidence {
            description: Some("would have been the name".into()),
            ..NameEvidence::default()
        },
    ] {
        assert_eq!(
            resolve_description(&evidence, &status),
            LocatorField::Absent,
            "nothing outranks the description, so there is no separate description"
        );
        assert_eq!(
            resolve_name(&evidence, &status),
            LocatorField::Unknown,
            "the uncertainty belongs to the name, which the description would have supplied"
        );
    }
}

/// The same failed read **is** `Unknown` once something else is the name,
/// because then a separate description could genuinely have existed.
#[test]
fn a_failed_description_is_unknown_once_a_stronger_source_is_the_name() {
    let evidence = NameEvidence {
        native_title: Some("Save".into()),
        ..NameEvidence::default()
    };
    let status = NameSlotStatus {
        description: SlotStatus::Uncertain,
        ..NameSlotStatus::default()
    };

    assert_eq!(
        resolve_name(&evidence, &status),
        LocatorField::Known("Save".into())
    );
    assert_eq!(
        resolve_description(&evidence, &status),
        LocatorField::Unknown
    );
}

#[test]
fn blank_evidence_is_ignored_without_rewriting_content() {
    let value = NameEvidence {
        explicit_label: Some(" \t ".into()),
        native_title: Some("  Save  ".into()),
        ..NameEvidence::default()
    };

    assert_eq!(compute_name(&value).as_deref(), Some("  Save  "));
}

#[test]
fn description_is_not_duplicated_when_it_supplies_the_name() {
    let value = NameEvidence {
        description: Some("Only description".into()),
        ..NameEvidence::default()
    };

    assert_eq!(compute_name(&value).as_deref(), Some("Only description"));
    assert_eq!(compute_description(&value), None);
}

#[test]
fn description_remains_separate_when_a_stronger_name_exists() {
    let value = NameEvidence {
        native_title: Some("Search".into()),
        description: Some("Filters all messages".into()),
        ..NameEvidence::default()
    };

    assert_eq!(compute_name(&value).as_deref(), Some("Search"));
    assert_eq!(
        compute_description(&value).as_deref(),
        Some("Filters all messages")
    );
}

/// `placeholder` is weaker than `description` in the shipped order, so a
/// placeholder does not turn a description into a description.
#[test]
fn a_placeholder_does_not_outrank_a_description() {
    let value = NameEvidence {
        placeholder: Some("Search".into()),
        description: Some("Filters all messages".into()),
        ..NameEvidence::default()
    };

    assert_eq!(
        compute_name(&value).as_deref(),
        Some("Filters all messages")
    );
    assert_eq!(compute_description(&value), None);
}
