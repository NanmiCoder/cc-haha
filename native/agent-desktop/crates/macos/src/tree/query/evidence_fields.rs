use agent_desktop_core::{
    LocatorField, NameEvidence, NameSlotStatus, SlotStatus, resolve_description, resolve_name,
};

use crate::tree::properties::node_attribute_status::{
    DESCRIPTION, LABEL, NodeAttributeStatus, PLACEHOLDER, TITLE, TITLE_ELEMENT, VALUE,
};

pub(crate) fn role_field(
    role: Option<&str>,
    subrole: Option<&str>,
    status: &NodeAttributeStatus,
) -> LocatorField<String> {
    if status.role_unknown() {
        LocatorField::Unknown
    } else {
        super::node_evidence::option_field(
            role.map(|role| crate::tree::roles::ax_role_and_subrole_to_str(role, subrole).into()),
            false,
        )
    }
}

/// The accessible name, computed by core.
///
/// This adapter holds no precedence of its own. It once did, and the copy it
/// held disagreed with the documented one - which is how a documented
/// precedence ended up with no caller at all. Everything platform-specific
/// about macOS's naming is folded into the per-slot status **here**, before
/// core is called, so the shared function never sees an `AX`-prefixed token.
pub(crate) fn name_field(
    evidence: &NameEvidence,
    status: &NodeAttributeStatus,
    role: Option<&str>,
    children_complete: bool,
) -> LocatorField<String> {
    resolve_name(evidence, &slot_status(status, role, children_complete))
}

pub(crate) fn description_field(
    evidence: &NameEvidence,
    status: &NodeAttributeStatus,
    role: Option<&str>,
    children_complete: bool,
) -> LocatorField<String> {
    resolve_description(evidence, &slot_status(status, role, children_complete))
}

/// Folds macOS's two platform gates into the platform-neutral slot status.
///
/// `static_value` is admitted only for `AXStaticText`. Suppressing the slot
/// must also suppress the uncertainty of an `AXValue` read that was never
/// going to be consulted, or every control with a transient value read would
/// lose its name.
///
/// `child_label`'s certainty is child enumeration: a label derived from
/// children the walk did not finish reading is a label that may be wrong.
fn slot_status(
    status: &NodeAttributeStatus,
    role: Option<&str>,
    children_complete: bool,
) -> NameSlotStatus {
    let static_text = role == Some("AXStaticText");
    NameSlotStatus {
        explicit_label: NameSlotStatus::uncertain_if(status.field_unknown(LABEL)),
        labelled_by_text: NameSlotStatus::uncertain_if(status.field_unknown(TITLE_ELEMENT)),
        native_title: NameSlotStatus::uncertain_if(status.field_unknown(TITLE)),
        static_value: if static_text {
            NameSlotStatus::uncertain_if(status.field_unknown(VALUE))
        } else {
            SlotStatus::Suppressed
        },
        child_label: NameSlotStatus::uncertain_if(!children_complete),
        placeholder: NameSlotStatus::uncertain_if(status.field_unknown(PLACEHOLDER)),
        description: NameSlotStatus::uncertain_if(status.field_unknown(DESCRIPTION)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_subrole_read_cannot_prove_a_canonical_role_or_state() {
        let mut status = NodeAttributeStatus::default();
        status.record_slot_error(
            crate::tree::properties::node_attribute_status::SUBROLE,
            accessibility_sys::kAXErrorCannotComplete,
        );

        assert_eq!(
            role_field(Some("AXGroup"), None, &status),
            LocatorField::Unknown
        );
        assert!(status.states_unknown());
        assert_eq!(
            role_field(
                Some("AXGroup"),
                Some("AXApplicationDialog"),
                &NodeAttributeStatus::default()
            ),
            LocatorField::Known("dialog".into()),
        );
    }

    #[test]
    fn transient_higher_priority_name_source_keeps_fallback_unknown() {
        let evidence = NameEvidence {
            native_title: Some("Save".into()),
            ..NameEvidence::default()
        };
        let mut status = NodeAttributeStatus::default();
        status.record_slot_error(LABEL, accessibility_sys::kAXErrorCannotComplete);

        assert_eq!(
            name_field(&evidence, &status, Some("AXButton"), true),
            LocatorField::Unknown
        );
    }

    #[test]
    fn known_higher_priority_name_ignores_lower_priority_unknowns() {
        let evidence = NameEvidence {
            explicit_label: Some("Save".into()),
            ..NameEvidence::default()
        };
        let mut status = NodeAttributeStatus::default();
        status.record_slot_error(TITLE, accessibility_sys::kAXErrorCannotComplete);

        assert_eq!(
            name_field(&evidence, &status, Some("AXButton"), true),
            LocatorField::Known("Save".into())
        );
    }

    #[test]
    fn description_remains_unknown_when_a_name_source_is_transient() {
        let evidence = NameEvidence {
            description: Some("Saves the draft".into()),
            ..NameEvidence::default()
        };
        let mut status = NodeAttributeStatus::default();
        status.record_slot_error(TITLE, accessibility_sys::kAXErrorCannotComplete);

        assert_eq!(
            name_field(&evidence, &status, Some("AXButton"), true),
            LocatorField::Unknown
        );
        assert_eq!(
            description_field(&evidence, &status, Some("AXButton"), true),
            LocatorField::Unknown
        );
    }

    #[test]
    fn description_only_evidence_is_the_name_not_a_duplicate_description() {
        let evidence = NameEvidence {
            description: Some("scroll-area".into()),
            ..NameEvidence::default()
        };
        let status = NodeAttributeStatus::default();

        assert_eq!(
            name_field(&evidence, &status, Some("AXScrollArea"), true),
            LocatorField::Known("scroll-area".into())
        );
        assert_eq!(
            description_field(&evidence, &status, Some("AXScrollArea"), true),
            LocatorField::Absent
        );
    }

    #[test]
    fn description_stays_separate_when_a_stronger_name_exists() {
        let evidence = NameEvidence {
            native_title: Some("Save".into()),
            description: Some("Saves the draft".into()),
            ..NameEvidence::default()
        };
        let status = NodeAttributeStatus::default();

        assert_eq!(
            name_field(&evidence, &status, Some("AXButton"), true),
            LocatorField::Known("Save".into())
        );
        assert_eq!(
            description_field(&evidence, &status, Some("AXButton"), true),
            LocatorField::Known("Saves the draft".into())
        );
    }

    #[test]
    fn explicit_label_also_preserves_a_separate_description() {
        let evidence = NameEvidence {
            explicit_label: Some("Save".into()),
            description: Some("Saves the draft".into()),
            ..NameEvidence::default()
        };
        let status = NodeAttributeStatus::default();

        assert_eq!(
            name_field(&evidence, &status, Some("AXButton"), true),
            LocatorField::Known("Save".into())
        );
        assert_eq!(
            description_field(&evidence, &status, Some("AXButton"), true),
            LocatorField::Known("Saves the draft".into())
        );
    }

    /// Byte-identical golden fixtures prove only what the fixtures cover. If
    /// none exercises a static-text element, a shared function that quietly
    /// dropped the `AXValue` slot would pass them all. This is the finer guard.
    #[test]
    fn a_static_text_is_named_by_its_value_and_other_roles_are_not() {
        let evidence = NameEvidence {
            static_value: Some("body copy".into()),
            ..NameEvidence::default()
        };
        let status = NodeAttributeStatus::default();

        assert_eq!(
            name_field(&evidence, &status, Some("AXStaticText"), true),
            LocatorField::Known("body copy".into())
        );
        assert_eq!(
            name_field(&evidence, &status, Some("AXButton"), true),
            LocatorField::Absent,
            "the value slot belongs to static text alone"
        );
    }

    /// Suppressing the value slot must suppress its uncertainty too. Without
    /// that, every control whose `AXValue` read failed transiently would lose
    /// a name it read perfectly well from a weaker source.
    ///
    /// The evidence deliberately carries no `native_title`: that slot outranks
    /// the value, so it would answer before the value's uncertainty was ever
    /// reached and the test would pass whether the suppression worked or not.
    #[test]
    fn a_failed_value_read_does_not_cloud_the_name_of_a_role_that_never_uses_it() {
        let evidence = NameEvidence {
            description: Some("a weaker source".into()),
            ..NameEvidence::default()
        };
        let mut status = NodeAttributeStatus::default();
        status.record_slot_error(VALUE, accessibility_sys::kAXErrorCannotComplete);

        assert_eq!(
            name_field(&evidence, &status, Some("AXButton"), true),
            LocatorField::Known("a weaker source".into()),
            "a button never consults the value, so a failed value read is not its problem"
        );
        assert_eq!(
            name_field(&evidence, &status, Some("AXStaticText"), true),
            LocatorField::Unknown,
            "a static text genuinely depends on the value it could not read"
        );
    }

    /// The other shape the golden fixtures may not cover: a label derived from
    /// children the walk did not finish reading is a label that may be wrong.
    #[test]
    fn an_incomplete_child_read_clouds_a_child_derived_name() {
        let evidence = NameEvidence {
            child_label: Some("derived from children".into()),
            ..NameEvidence::default()
        };
        let status = NodeAttributeStatus::default();

        assert_eq!(
            name_field(&evidence, &status, Some("AXGroup"), true),
            LocatorField::Known("derived from children".into())
        );
        assert_eq!(
            name_field(&evidence, &status, Some("AXGroup"), false),
            LocatorField::Unknown
        );
    }

    #[test]
    fn unknown_description_cannot_be_bypassed_by_child_content() {
        let evidence = NameEvidence {
            child_label: Some("fallback child".into()),
            ..NameEvidence::default()
        };
        let mut status = NodeAttributeStatus::default();
        status.record_slot_error(DESCRIPTION, accessibility_sys::kAXErrorCannotComplete);

        assert_eq!(
            name_field(&evidence, &status, Some("AXGroup"), true),
            LocatorField::Unknown
        );
    }

    #[test]
    fn a_wide_nameless_row_with_a_complete_child_label_read_is_absent_not_unknown() {
        let evidence = NameEvidence::default();
        let status = NodeAttributeStatus::default();

        assert_eq!(
            name_field(&evidence, &status, Some("AXRow"), true),
            LocatorField::Absent
        );
    }
}
