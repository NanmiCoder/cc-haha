use agent_desktop_core::{
    IdentifierEvidence, LocatorEvidence, LocatorField, LocatorRefEvidence, LocatorStats,
};

fn is_wrapper_candidate(
    role: Option<&str>,
    subrole: Option<&str>,
    name: &agent_desktop_core::NameEvidence,
    value: Option<&str>,
    identifiers: &IdentifierEvidence,
) -> bool {
    role.is_some_and(|role| {
        crate::tree::roles::ax_role_and_subrole_to_str(role, subrole) == "group"
    }) && direct_wrapper_identity_is_empty(name, value, identifiers)
}

pub(crate) fn is_transparent_wrapper(
    role: Option<&str>,
    subrole: Option<&str>,
    name: &agent_desktop_core::NameEvidence,
    value: Option<&str>,
    identifiers: &IdentifierEvidence,
    actions: &LocatorField<Vec<String>>,
) -> bool {
    is_wrapper_candidate(role, subrole, name, value, identifiers)
        && actions
            .known()
            .is_some_and(|actions| actions.iter().all(|action| is_structural_action(action)))
}

fn direct_wrapper_identity_is_empty(
    name: &agent_desktop_core::NameEvidence,
    value: Option<&str>,
    identifiers: &IdentifierEvidence,
) -> bool {
    [
        name.explicit_label.as_deref(),
        name.labelled_by_text.as_deref(),
        name.native_title.as_deref(),
        name.static_value.as_deref(),
        name.child_label.as_deref(),
        name.placeholder.as_deref(),
        name.description.as_deref(),
        value,
    ]
    .into_iter()
    .all(|text| text.is_none_or(|text| text.trim().is_empty()))
        && identifiers.is_complete()
        && identifiers.identifiers().is_empty()
}

fn is_structural_action(action: &str) -> bool {
    matches!(
        action,
        agent_desktop_core::actions::capability::RIGHT_CLICK
            | agent_desktop_core::actions::capability::SCROLL_TO
            | agent_desktop_core::actions::capability::SET_FOCUS
    )
}

pub(crate) fn option_field<T>(value: Option<T>, uncertain: bool) -> LocatorField<T> {
    match value {
        Some(value) => LocatorField::Known(value),
        None if uncertain => LocatorField::Unknown,
        None => LocatorField::Absent,
    }
}

pub(crate) fn update_identifier_stats(identifiers: &IdentifierEvidence, stats: &mut LocatorStats) {
    let count = identifiers.identifiers().len() as u64;
    stats.identifiers.values_observed += count;
    stats.identifiers.nodes_with_identifiers += u64::from(count > 0);
    stats.identifiers.nodes_with_multiple_identifiers += u64::from(count > 1);
}

pub(crate) fn unknown() -> LocatorEvidence {
    LocatorEvidence {
        role: LocatorField::Unknown,
        name: LocatorField::Unknown,
        description: LocatorField::Unknown,
        value: LocatorField::Unknown,
        identifiers: IdentifierEvidence::unknown(),
        states: LocatorField::Unknown,
        ref_evidence: LocatorRefEvidence {
            window_bounds: LocatorField::Absent,
            bounds: LocatorField::Unknown,
            available_actions: LocatorField::Unknown,
            descriptors: Default::default(),
        },
    }
}

pub(crate) fn identifiers(
    identifiers: &crate::tree::properties::node_identifiers::NodeIdentifiers,
    requested: bool,
) -> IdentifierEvidence {
    if !requested {
        return IdentifierEvidence::unknown();
    }
    let complete =
        !identifiers.ax_identifier.is_unknown() && !identifiers.ax_dom_identifier.is_unknown();
    let mut values = Vec::new();
    if let Some(value) = identifiers.ax_identifier.known() {
        values.push(agent_desktop_core::ElementIdentifier {
            kind: agent_desktop_core::IdentifierKind::AxIdentifier,
            value: value.clone(),
        });
    }
    let preferred = if let Some(value) = identifiers.ax_dom_identifier.known() {
        let index = values.len();
        values.push(agent_desktop_core::ElementIdentifier {
            kind: agent_desktop_core::IdentifierKind::AxDomIdentifier,
            value: value.clone(),
        });
        Some(index)
    } else {
        (!values.is_empty()).then_some(0)
    };
    IdentifierEvidence::typed(values, preferred, complete)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dom_identifier_is_preferred_without_discarding_ax_identifier() {
        let identifiers = crate::tree::properties::node_identifiers::NodeIdentifiers::from_fields(
            LocatorField::Known("native-save".into()),
            LocatorField::Known("dom-save".into()),
        );
        let evidence = super::identifiers(&identifiers, true);

        assert_eq!(evidence.identifiers().len(), 2);
        assert_eq!(
            evidence.preferred_identifier(),
            Some(&agent_desktop_core::ElementIdentifier {
                kind: agent_desktop_core::IdentifierKind::AxDomIdentifier,
                value: "dom-save".into(),
            })
        );
    }

    #[test]
    fn equal_strings_remain_distinct_across_identifier_kinds() {
        let identifiers = crate::tree::properties::node_identifiers::NodeIdentifiers::from_fields(
            LocatorField::Known("shared".into()),
            LocatorField::Known("shared".into()),
        );
        let evidence = super::identifiers(&identifiers, true);

        assert_eq!(evidence.identifiers().len(), 2);
        assert_ne!(
            evidence.identifiers()[0].kind,
            evidence.identifiers()[1].kind
        );
    }

    fn inert_generic_wrapper() -> (
        agent_desktop_core::NameEvidence,
        IdentifierEvidence,
        LocatorField<Vec<String>>,
    ) {
        (
            agent_desktop_core::NameEvidence::default(),
            IdentifierEvidence::absent(),
            LocatorField::Known(Vec::new()),
        )
    }

    #[test]
    fn inert_native_groups_are_transparent() {
        let (name, identifiers, actions) = inert_generic_wrapper();

        for role in ["AXGenericElement", "AXGroup"] {
            assert!(is_transparent_wrapper(
                Some(role),
                None,
                &name,
                None,
                &identifiers,
                &actions,
            ));
        }
    }

    #[test]
    fn named_or_actionable_generic_elements_consume_logical_depth() {
        let (mut name, identifiers, actions) = inert_generic_wrapper();
        name.native_title = Some("Settings".into());
        assert!(!is_transparent_wrapper(
            Some("AXGenericElement"),
            None,
            &name,
            None,
            &identifiers,
            &actions,
        ));

        name.native_title = None;
        let actions =
            LocatorField::Known(vec![agent_desktop_core::actions::capability::CLICK.into()]);
        assert!(!is_transparent_wrapper(
            Some("AXGenericElement"),
            None,
            &name,
            None,
            &identifiers,
            &actions,
        ));
    }

    #[test]
    fn structural_actions_do_not_make_anonymous_groups_consume_depth() {
        let (name, identifiers, _) = inert_generic_wrapper();
        let actions = LocatorField::Known(vec![
            agent_desktop_core::actions::capability::RIGHT_CLICK.into(),
            agent_desktop_core::actions::capability::SCROLL_TO.into(),
            agent_desktop_core::actions::capability::SET_FOCUS.into(),
        ]);

        assert!(is_transparent_wrapper(
            Some("AXGroup"),
            None,
            &name,
            None,
            &identifiers,
            &actions,
        ));
    }
}
