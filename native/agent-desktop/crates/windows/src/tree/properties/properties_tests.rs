use super::*;
use crate::tree::properties::element_properties::ResolvedVocabulary;
use crate::tree::test_support::text;
use agent_desktop_core::{IdentifierKind, LocatorField, Rect};

fn reads(entries: &[(TreeProperty, PropertyOutcome)]) -> ElementProperties {
    crate::tree::test_support::props(entries)
}

#[test]
fn a_property_the_provider_does_not_implement_is_absent_not_unknown() {
    let properties = reads(&[(TreeProperty::Name, PropertyOutcome::Absent)]);

    assert_eq!(
        properties.get(TreeProperty::Name).text(),
        LocatorField::Absent
    );
    assert!(!properties.get(TreeProperty::Name).text().is_unknown());
}

#[test]
fn a_property_whose_read_failed_is_unknown_not_absent() {
    let properties = reads(&[(TreeProperty::Name, PropertyOutcome::Unknown)]);

    assert_eq!(
        properties.get(TreeProperty::Name).text(),
        LocatorField::Unknown
    );
}

#[test]
fn an_empty_but_present_string_stays_known() {
    let properties = reads(&[(TreeProperty::Name, text(""))]);

    assert_eq!(
        properties.get(TreeProperty::Name).text(),
        LocatorField::Known(String::new())
    );
}

#[test]
fn a_string_past_the_bound_is_unknown_and_is_never_truncated_into_evidence() {
    let oversized = "x".repeat(MAX_EVIDENCE_CHARS + 1);

    let outcome = bounded_text(oversized.clone());

    assert_eq!(outcome, PropertyOutcome::Unknown);
    assert_eq!(outcome.text(), LocatorField::Unknown);
    assert_eq!(
        bounded_text("x".repeat(MAX_EVIDENCE_CHARS)).text(),
        LocatorField::Known("x".repeat(MAX_EVIDENCE_CHARS))
    );
}

/// The ASCII boundary test above cannot catch a `.len()`-for-`.chars().count()`
/// swap: for a one-byte-per-char string the two counts agree. A two-byte
/// character exposes it - at exactly the bound its byte length is already
/// past `MAX_EVIDENCE_CHARS` while its char count is not.
#[test]
fn a_multi_byte_char_string_is_bounded_by_char_count_not_byte_length() {
    let at_bound = "é".repeat(MAX_EVIDENCE_CHARS);
    let past_bound = "é".repeat(MAX_EVIDENCE_CHARS + 1);

    assert_eq!(
        bounded_text(at_bound.clone()).text(),
        LocatorField::Known(at_bound)
    );
    assert_eq!(bounded_text(past_bound).text(), LocatorField::Unknown);
}

/// The secure-field gate, asserted on the projection rather than on a
/// provider: every value-bearing property is withheld when `IsPassword` is
/// true, and nothing else is.
#[test]
fn a_secure_element_withholds_every_value_bearing_property() {
    let mut entries = vec![
        (
            TreeProperty::IsPassword,
            PropertyOutcome::Known(PropertyValue::Flag(true)),
        ),
        (TreeProperty::AutomationId, text("field-1")),
        (TreeProperty::ClassName, text("Edit")),
    ];
    for property in TreeProperty::VALUE_BEARING {
        entries.push((property, text("zzsecretzz")));
    }
    let properties = reads(&entries);

    assert!(properties.is_secure());
    for property in TreeProperty::VALUE_BEARING {
        assert_eq!(
            properties.get(property),
            PropertyOutcome::Absent,
            "{} leaked through a secure element",
            property.as_str()
        );
    }
    assert_eq!(properties.get(TreeProperty::AutomationId), text("field-1"));
    assert_eq!(properties.get(TreeProperty::ClassName), text("Edit"));
}

#[test]
fn a_non_secure_element_keeps_every_value_bearing_property() {
    let properties = reads(&[
        (
            TreeProperty::IsPassword,
            PropertyOutcome::Known(PropertyValue::Flag(false)),
        ),
        (TreeProperty::Name, text("visible-name")),
        (TreeProperty::Value, text("visible-value")),
    ]);

    assert!(!properties.is_secure());
    assert_eq!(properties.get(TreeProperty::Name), text("visible-name"));
    assert_eq!(properties.get(TreeProperty::Value), text("visible-value"));
}

/// The gate fails closed. A failed `IsPassword` read is not evidence the
/// element is safe to publish, and the costs are asymmetric: withholding a
/// name that was not secret loses a little evidence, publishing one that was
/// puts a password into a snapshot, a session JSONL segment and a trace HTML
/// export.
#[test]
fn an_unreadable_is_password_withholds_rather_than_publishing() {
    let properties = reads(&[
        (TreeProperty::IsPassword, PropertyOutcome::Unknown),
        (TreeProperty::Value, text("visible-value")),
    ]);

    assert!(properties.is_secure());
    assert_eq!(properties.get(TreeProperty::Value), PropertyOutcome::Absent);
}

/// Withholding replaces content, it does not invent an answer. When the whole
/// read failed there is nothing to withhold, and rewriting `Unknown` to
/// `Absent` would claim the provider does not implement the property — the
/// fabrication A14-9 forbids, because `Absent` satisfies
/// `EvidenceRequirements` and a target that never answered must not.
#[test]
fn withholding_never_turns_a_failed_read_into_a_real_answer() {
    let properties = reads(&[
        (TreeProperty::IsPassword, PropertyOutcome::Unknown),
        (TreeProperty::Value, PropertyOutcome::Unknown),
        (TreeProperty::Name, text("readable-name")),
    ]);

    assert!(properties.is_secure());
    assert_eq!(
        properties.get(TreeProperty::Value),
        PropertyOutcome::Unknown,
        "a failed read has no content to withhold"
    );
    assert_eq!(
        properties.get(TreeProperty::Name),
        PropertyOutcome::Absent,
        "content that was actually read is withheld"
    );
}

/// A provider that answers `IsPassword` as an integer where UIA documents a
/// boolean must not slip past the gate. Reading only `VT_BOOL` would let it.
#[test]
fn an_integer_is_password_still_closes_the_gate() {
    let properties = reads(&[
        (
            TreeProperty::IsPassword,
            PropertyOutcome::Known(PropertyValue::Number(1)),
        ),
        (TreeProperty::Value, text("secret-value")),
    ]);

    assert!(properties.is_secure());
    assert_eq!(properties.get(TreeProperty::Value), PropertyOutcome::Absent);
}

/// A provider that answers `IsPassword` and does not implement it has given a
/// real answer, so the gate stays open - otherwise every element on a provider
/// without the property would lose its name and value.
#[test]
fn an_absent_is_password_is_a_real_answer_and_leaves_content_readable() {
    let properties = reads(&[
        (TreeProperty::IsPassword, PropertyOutcome::Absent),
        (TreeProperty::Value, text("visible-value")),
    ]);

    assert!(!properties.is_secure());
    assert_eq!(properties.get(TreeProperty::Value), text("visible-value"));
}

/// An element whose read set never asked for `IsPassword` is not gated: there
/// was nothing to gate, and the walk chooses the property set.
#[test]
fn a_read_set_without_the_flag_is_not_gated() {
    let properties = reads(&[(TreeProperty::Value, text("visible-value"))]);

    assert!(!properties.is_secure());
    assert_eq!(properties.get(TreeProperty::Value), text("visible-value"));
}

/// `AutomationId` -> `native_id` shipped ahead of the work that nominally
/// owned it, and shipped without a test. These pin the three rules it
/// actually implements, each of which fails when inverted.
///
/// A blank id must produce no identifier at all. `IdentifierEvidence::typed`
/// filters it, so an adapter that stopped filtering would hand every
/// unidentified element the same empty key and make them mutually
/// indistinguishable to re-identification.
#[test]
fn a_blank_automation_id_produces_no_identifier() {
    for blank in ["", "   ", "\t"] {
        let evidence = reads(&[(TreeProperty::AutomationId, text(blank))])
            .locator_evidence(ResolvedVocabulary::unknown());

        assert!(
            evidence.identifiers.preferred_identifier().is_none(),
            "a blank automation id became an identifier"
        );
        assert!(
            evidence.identifiers.is_complete(),
            "a provider that answered with a blank id gave a real answer"
        );
    }
}

/// The kind must be `AutomationId` and never `Unknown`: `refs_validate.rs`
/// hard-rejects a populated `native_id` whose kind is `Unknown`, so an
/// identifier stamped wrong is one that is silently dropped at persistence.
#[test]
fn a_populated_automation_id_carries_its_kind_and_survives_validation() {
    let evidence = reads(&[(TreeProperty::AutomationId, text("save-button"))])
        .locator_evidence(ResolvedVocabulary::unknown());

    let identifier = evidence
        .identifiers
        .preferred_identifier()
        .expect("a populated automation id is the preferred identifier");
    assert_eq!(identifier.kind, IdentifierKind::AutomationId);
    assert_ne!(
        identifier.kind,
        IdentifierKind::Unknown,
        "refs_validate rejects a populated native_id whose kind is Unknown"
    );
    assert_eq!(identifier.value, "save-button");
}

/// A failed read is incomplete evidence, not an absent identifier. `Absent`
/// satisfies completeness gating, so reporting a target that never answered as
/// "has no id" would let it satisfy requirements it never met.
#[test]
fn a_failed_automation_id_read_is_incomplete_evidence_rather_than_an_absent_id() {
    let failed = reads(&[(TreeProperty::AutomationId, PropertyOutcome::Unknown)])
        .locator_evidence(ResolvedVocabulary::unknown());
    let absent = reads(&[(TreeProperty::AutomationId, PropertyOutcome::Absent)])
        .locator_evidence(ResolvedVocabulary::unknown());

    assert!(!failed.identifiers.is_complete());
    assert!(absent.identifiers.is_complete());
    assert!(failed.identifiers.preferred_identifier().is_none());
}

/// The interpreted slots carry what the vocabulary resolved, not what the
/// read set happens to hold.
///
/// The name and description the vocabulary supplies are deliberately
/// **different** from anything in the read set: core composes the name from a
/// label relation the raw `Name` property does not carry, so a projection that
/// quietly recomputed it from `Name`/`HelpText` would be a real regression and
/// would be invisible if both sources agreed. `Name` reads one string here and
/// the vocabulary another; `HelpText` reads text while the vocabulary's
/// description is `Absent`.
#[test]
fn the_evidence_projection_fills_every_slot_the_walk_owns() {
    let evidence = reads(&[
        (TreeProperty::Name, text("Save")),
        (TreeProperty::Value, text("draft")),
        (TreeProperty::HelpText, text("press to save the draft")),
        (
            TreeProperty::BoundingRectangle,
            PropertyOutcome::Known(PropertyValue::Bounds(Rect {
                x: 1.0,
                y: 2.0,
                width: 3.0,
                height: 4.0,
            })),
        ),
    ])
    .locator_evidence(ResolvedVocabulary {
        role: LocatorField::Known("button".into()),
        available_actions: LocatorField::Known(Vec::new()),
        states: LocatorField::Known(vec!["focused".into()]),
        name: LocatorField::Known("Save (labelled)".into()),
        description: LocatorField::Absent,
    });

    assert_eq!(evidence.value, LocatorField::Known("draft".into()));
    assert!(!evidence.ref_evidence.bounds.is_unknown());
    assert_eq!(
        evidence.name,
        LocatorField::Known("Save (labelled)".into()),
        "the name is the vocabulary's, carried through rather than recomputed from the read set"
    );
    assert_eq!(
        evidence.description,
        LocatorField::Absent,
        "the description is the vocabulary's absence, not the read set's help text"
    );
    assert_eq!(evidence.role, LocatorField::Known("button".into()));
    assert_eq!(
        evidence.states,
        LocatorField::Known(vec!["focused".into()]),
        "every interpreted slot carries what the caller resolved, rather than a literal the projection invented"
    );
}

/// A failed read must name the property and never carry its content. A
/// provider is free to hand back nonsense. An inverted side is degenerate,
/// not negative-sized, and an extreme one must not overflow a debug build.
#[test]
fn a_rectangle_side_is_never_negative_and_never_overflows() {
    assert_eq!(extent(10, 40), 30.0);
    assert_eq!(extent(40, 10), 0.0, "an inverted side collapses to zero");
    assert_eq!(extent(7, 7), 0.0);
    assert_eq!(
        extent(i32::MIN, i32::MAX),
        f64::from(i32::MAX),
        "an extreme span saturates rather than overflowing"
    );
    assert_eq!(extent(i32::MAX, i32::MIN), 0.0);
}

#[test]
fn a_property_read_error_names_the_property_and_carries_no_content() {
    const MARKER: &str = "zzmarkerzz-account-number";
    let base = crate::tree::automation::uia_failure_error(
        crate::tree::automation::UiaFailure::Sentinel(crate::tree::automation::ERR_TIMEOUT),
        "read an element property",
    );

    let error = property_read_error(base, TreeProperty::Value);

    let rendered = format!(
        "{}|{}|{}",
        error.message,
        error.platform_detail.clone().unwrap_or_default(),
        serde_json::to_string(&error.details).unwrap_or_default()
    );
    assert!(
        rendered.contains("Value"),
        "the error must name the property"
    );
    assert!(!rendered.contains(MARKER), "leaked: {rendered}");
}

#[cfg(target_os = "windows")]
#[path = "properties_live_tests.rs"]
mod windows_only;
