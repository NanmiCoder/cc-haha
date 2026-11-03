use super::*;

fn identifier(value: &str) -> crate::ElementIdentifier {
    identifier_of_kind(crate::IdentifierKind::AxIdentifier, value)
}

fn dom_identifier(value: &str) -> crate::ElementIdentifier {
    identifier_of_kind(crate::IdentifierKind::AxDomIdentifier, value)
}

fn identifier_of_kind(kind: crate::IdentifierKind, value: &str) -> crate::ElementIdentifier {
    crate::ElementIdentifier {
        kind,
        value: value.into(),
    }
}
use crate::{
    SnapshotSurface,
    locator::live_locator::{IdentifierEvidence, LocatorField},
};

fn entry() -> RefEntry {
    RefEntry {
        process: crate::RefProcess {
            pid: crate::ProcessId::new(1),
            process_instance: Some("test-instance".into()),
        },
        identity: crate::RefEntryIdentity {
            retained_object: None,
            role: "button".into(),
            name: None,
            value: None,
            description: None,
            native_id: None,
        },
        geometry: crate::RefGeometry {
            bounds_space: None,
            bounds: None,
            bounds_hash: None,
        },
        capabilities: crate::RefCapabilities {
            states: vec![],
            available_actions: vec![],
        },
        source: crate::RefSource {
            source_app: None,
            source_window_id: None,
            source_window_title: None,
            source_window_bounds_hash: None,
            source_surface: SnapshotSurface::Window,
        },
        scope: crate::RefScope {
            root_ref: None,
            path_is_absolute: false,
            path: smallvec::SmallVec::new(),
        },
    }
}

#[test]
fn empty_identity_remains_unknown_without_positive_evidence() {
    let mut entry = entry();
    entry.identity.role = "menubutton".into();
    entry.identity.name = Some(String::new());

    assert!(!has_meaningful_identity(&entry));
    assert!(!identity_matches(&entry, None, None, None, None));
    assert!(!identity_matches(&entry, Some(""), None, None, None));
    assert!(!identity_matches(&entry, None, Some(""), None, None));
    assert!(!identity_matches(
        &entry,
        Some("Insert Shape"),
        None,
        None,
        None
    ));
}

#[test]
fn description_identity_matches_blank_title_controls() {
    let mut entry = entry();
    entry.identity.description = Some("Insert Text Box".into());

    assert!(has_meaningful_identity(&entry));
    assert!(identity_matches(
        &entry,
        Some(""),
        None,
        Some("Insert Text Box"),
        None,
    ));
    assert!(identity_matches(
        &entry,
        Some("Insert Text Box"),
        None,
        None,
        None,
    ));
    assert!(!identity_matches(&entry, Some(""), None, None, None));
    assert!(!identity_matches(
        &entry,
        Some(""),
        None,
        Some("Insert Shape"),
        None,
    ));
}

#[test]
fn name_identity_cannot_be_rescued_by_matching_description() {
    let mut entry = entry();
    entry.identity.name = Some("Primary".into());
    entry.identity.description = Some("Generic".into());

    assert!(identity_matches(&entry, Some("Primary"), None, None, None));
    assert!(identity_matches(&entry, None, Some("Primary"), None, None));
    assert!(!identity_matches(
        &entry,
        Some("Other"),
        None,
        Some("Primary"),
        None,
    ));
    assert!(!identity_matches(&entry, Some("Generic"), None, None, None));
}

#[test]
fn value_identity_cannot_be_rescued_by_matching_name_when_value_mismatches() {
    let mut entry = entry();
    entry.identity.value = Some("On".into());

    assert!(identity_matches(&entry, None, Some("On"), None, None));
    assert!(identity_matches(&entry, Some("On"), None, None, None));
    assert!(!identity_matches(
        &entry,
        Some("On"),
        Some("Off"),
        None,
        None
    ));
}

#[test]
fn mutable_value_change_cannot_prove_identity_by_itself() {
    let mut entry = entry();
    entry.identity.role = "textfield".into();
    entry.identity.value = Some("seed".into());

    assert!(!has_meaningful_identity(&entry));
    assert!(!identity_matches(&entry, None, Some("changed"), None, None));
}

#[test]
fn unnamed_mutable_value_role_cannot_use_content_as_identity() {
    let mut entry = entry();
    entry.identity.role = "textfield".into();

    assert!(!has_meaningful_identity(&entry));
    assert!(!identity_matches(
        &entry,
        Some("typed document text"),
        Some("typed document text"),
        None,
        None
    ));
}

#[test]
fn mutable_value_text_promoted_to_name_remains_unknown() {
    let mut entry = entry();
    entry.identity.role = "textfield".into();
    entry.identity.name = Some("00:01".into());
    entry.identity.value = Some("00:01".into());

    assert!(!has_meaningful_identity(&entry));
    assert!(!identity_matches(
        &entry,
        Some("00:06"),
        Some("00:06"),
        None,
        None
    ));
}

#[test]
fn formatted_numeric_mutable_value_promoted_to_name_is_not_stable_identity() {
    let mut entry = entry();
    entry.identity.role = "slider".into();
    entry.identity.name = Some("50".into());
    entry.identity.value = Some("50.0".into());

    assert!(!has_meaningful_identity(&entry));
    assert!(!identity_matches(
        &entry,
        Some("51"),
        Some("51.0"),
        None,
        None
    ));
}

#[test]
fn named_mutable_value_role_still_uses_name_identity() {
    let mut entry = entry();
    entry.identity.role = "textfield".into();
    entry.identity.name = Some("Search".into());
    entry.identity.value = Some("old query".into());

    assert!(has_meaningful_identity(&entry));
    assert!(identity_matches(
        &entry,
        Some("Search"),
        Some("new query"),
        None,
        None
    ));
    assert!(!identity_matches(
        &entry,
        Some("Replace"),
        Some("new query"),
        None,
        None
    ));
}

#[test]
fn mutable_role_label_different_from_value_remains_stable_identity() {
    let mut entry = entry();
    entry.identity.role = "combobox".into();
    entry.identity.name = Some("Font".into());
    entry.identity.value = Some("Helvetica".into());

    assert!(has_meaningful_identity(&entry));
    assert!(identity_matches(
        &entry,
        Some("Font"),
        Some("Arial"),
        None,
        None
    ));
    assert!(!identity_matches(
        &entry,
        Some("Size"),
        Some("Arial"),
        None,
        None
    ));
}

#[test]
fn native_id_is_strongest_identity_signal() {
    let mut entry = entry();
    entry.identity.native_id = Some(identifier("submit-btn"));
    entry.identity.name = Some("Old Label".into());

    assert!(has_meaningful_identity(&entry));
    assert!(identity_matches(
        &entry,
        Some("Renamed"),
        None,
        None,
        Some("submit-btn"),
    ));
    assert!(!identity_matches(
        &entry,
        Some("Renamed"),
        None,
        None,
        Some("cancel-btn"),
    ));
}

#[test]
fn differing_native_ids_are_hard_non_match() {
    let mut entry = entry();
    entry.identity.native_id = Some(identifier("field-a"));
    entry.identity.name = Some("Same".into());

    assert!(!identity_matches(
        &entry,
        Some("Same"),
        None,
        None,
        Some("field-b"),
    ));
}

#[test]
fn missing_live_native_id_fails_closed_even_with_stable_name() {
    let mut entry = entry();
    entry.identity.native_id = Some(identifier("compose-message"));
    entry.identity.name = Some("Send".into());

    assert!(!identity_matches(&entry, Some("Send"), None, None, None,));
    assert!(!identity_matches(&entry, Some("Cancel"), None, None, None,));
}

#[test]
fn incomplete_identifier_slots_cannot_prove_a_non_match() {
    let mut entry = entry();
    entry.identity.native_id = Some(identifier("dom-submit"));
    let identifiers = IdentifierEvidence::typed([identifier("ax-submit")], Some(0), false);

    assert_eq!(
        identity_match(
            &entry,
            &LocatorField::Known("Submit".into()),
            &LocatorField::Absent,
            &LocatorField::Absent,
            &identifiers,
        ),
        IdentityMatch::Unknown
    );
}

#[test]
fn unavailable_identifier_fails_closed_before_stable_text_fallback() {
    let mut entry = entry();
    entry.identity.native_id = Some(identifier("old-dom-id"));
    entry.identity.name = Some("Submit".into());
    let absent = IdentifierEvidence::absent();

    assert_eq!(
        identity_match(
            &entry,
            &LocatorField::Known("Submit".into()),
            &LocatorField::Absent,
            &LocatorField::Absent,
            &absent,
        ),
        IdentityMatch::NoMatch
    );

    entry.identity.name = None;
    assert_eq!(
        identity_match(
            &entry,
            &LocatorField::Absent,
            &LocatorField::Absent,
            &LocatorField::Absent,
            &absent,
        ),
        IdentityMatch::NoMatch
    );
}

#[test]
fn unknown_stable_text_field_does_not_collapse_to_absence() {
    let mut entry = entry();
    entry.identity.name = Some("Submit".into());

    assert_eq!(
        identity_match(
            &entry,
            &LocatorField::Unknown,
            &LocatorField::Absent,
            &LocatorField::Absent,
            &IdentifierEvidence::absent(),
        ),
        IdentityMatch::Unknown
    );
}
#[path = "ref_identity_scroll_tests.rs"]
mod scroll_tests;

#[path = "ref_identity_fields_tests.rs"]
mod fields_tests;

#[path = "ref_identity_kind_tests.rs"]
mod kind_tests;
