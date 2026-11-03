use agent_desktop_core::{AdapterError, ErrorCode, EvidenceRequirements, LocatorEvidence};

pub(crate) fn collection_target(
    element: &crate::tree::AXElement,
    root: &crate::tree::AXElement,
    value: &str,
    deadline: std::time::Instant,
) -> Result<Option<crate::tree::AXElement>, AdapterError> {
    let (read, stats) = candidate_read(element, deadline)?;
    let named = evidence_matches(&read.evidence, value, stats)?;
    if !named && !text_value_matches(element, &read.attrs, value, deadline)? {
        return Ok(None);
    }
    collection_owner(
        element,
        root,
        named,
        |node| {
            Ok((
                crate::tree::surface_read::string(node, "AXRole", deadline)?,
                crate::tree::surface_read::element(node, "AXParent", deadline)?,
            ))
        },
        crate::tree::properties::capabilities::same_element,
    )
}

fn collection_owner<T: Clone>(
    element: &T,
    root: &T,
    named: bool,
    mut read: impl FnMut(&T) -> Result<(Option<String>, Option<T>), AdapterError>,
    same: impl Fn(&T, &T) -> bool,
) -> Result<Option<T>, AdapterError> {
    let mut selectable = None;
    let mut row = None;
    let mut current = element.clone();
    for _ in 0..8 {
        if same(&current, root) {
            return Ok(row.or(selectable));
        }
        let (role, parent) = read(&current)?;
        if row.is_none() && role.as_deref() == Some("AXRow") {
            row = Some(current.clone());
        }
        if role.as_deref().is_some_and(|role| {
            super::container_select::role_activates_by_selection(
                crate::tree::roles::ax_role_to_str(role),
            )
        }) {
            selectable.get_or_insert_with(|| current.clone());
        } else if named
            && selectable.is_none()
            && same(&current, element)
            && !matches!(
                role.as_deref(),
                Some("AXTextField" | "AXTextArea" | "AXSecureTextField")
            )
        {
            selectable = Some(current.clone());
        }
        let Some(parent) = parent else {
            return Err(incomplete("owner_parent_missing"));
        };
        current = parent;
    }
    Err(incomplete("owner_depth_limit"))
}

fn text_value_matches(
    element: &crate::tree::AXElement,
    attrs: &crate::tree::NodeAttrs,
    value: &str,
    deadline: std::time::Instant,
) -> Result<bool, AdapterError> {
    if attrs.role.as_deref() != Some("AXTextField") {
        return Ok(false);
    }
    if attrs.subrole.as_deref() == Some("AXSecureTextField") {
        return Ok(false);
    }
    Ok(
        crate::tree::surface_read::string(element, "AXValue", deadline)?
            .is_some_and(|text| text.eq_ignore_ascii_case(value)),
    )
}

pub(crate) fn matches(
    element: &crate::tree::AXElement,
    value: &str,
    deadline: std::time::Instant,
) -> Result<bool, AdapterError> {
    let (read, stats) = candidate_read(element, deadline)?;
    evidence_matches(&read.evidence, value, stats)
}

fn candidate_read(
    element: &crate::tree::AXElement,
    deadline: std::time::Instant,
) -> Result<
    (
        crate::tree::query::node_read::NodeRead,
        agent_desktop_core::LocatorStats,
    ),
    AdapterError,
> {
    let mut usage = crate::tree::observation_usage::ObservationUsage::with_defaults();
    let mut stats = agent_desktop_core::LocatorStats::default();
    let mut requirements = EvidenceRequirements {
        role: true,
        name: true,
        description: true,
        ..Default::default()
    };
    requirements.ref_evidence.actions = true;
    let read = crate::tree::query::node_read::read_node(
        element,
        crate::tree::query::node_read_context::NodeReadContext {
            tree: &crate::tree::TreeBuildContext::empty(false),
            stats: &mut stats,
            usage: &mut usage,
            requirements,
            deadline,
            child_plan: crate::tree::query::child_read_plan::ChildReadPlan::boundary_aware(
                0,
                crate::tree::child_labels::MAX_LABEL_ELEMENTS,
                1,
                0,
            ),
        },
    )?;
    if read.invalid_element {
        return Err(AdapterError::stale_ref_because(
            "Selection candidate became invalid",
        ));
    }
    Ok((read, stats))
}

fn evidence_matches(
    evidence: &LocatorEvidence,
    value: &str,
    stats: agent_desktop_core::LocatorStats,
) -> Result<bool, AdapterError> {
    matches_evidence(evidence, value).map_err(|mut error| {
        if let Some(details) = error
            .details
            .as_mut()
            .and_then(serde_json::Value::as_object_mut)
        {
            details.insert("query_stats".into(), serde_json::json!(stats));
        }
        error
    })
}

fn matches_evidence(evidence: &LocatorEvidence, value: &str) -> Result<bool, AdapterError> {
    let actions = evidence
        .ref_evidence
        .available_actions
        .known()
        .ok_or_else(|| incomplete("actions_unknown"))?;
    if !actions
        .iter()
        .any(|action| action == agent_desktop_core::actions::capability::CLICK)
    {
        return Ok(false);
    }
    if evidence.name.is_unknown() || evidence.description.is_unknown() {
        return Err(incomplete(if evidence.name.is_unknown() {
            "name_unknown"
        } else {
            "description_unknown"
        }));
    }
    Ok([&evidence.name, &evidence.description]
        .into_iter()
        .any(|field| {
            field
                .known()
                .is_some_and(|name| name.eq_ignore_ascii_case(value))
        }))
}

fn incomplete(phase: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::AppUnresponsive,
        "Selection candidate evidence was incomplete",
    )
    .with_details(
        serde_json::json!({ "kind": "selection_evidence", "phase": phase, "complete": false }),
    )
    .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered())
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_desktop_core::{IdentifierEvidence, LocatorField, LocatorRefEvidence};

    fn owner(roles: &[&str], named: bool) -> Result<Option<usize>, AdapterError> {
        collection_owner(
            &0,
            &(roles.len() - 1),
            named,
            |index| Ok((Some(roles[*index].into()), Some(index + 1))),
            |left, right| left == right,
        )
    }

    #[test]
    fn collection_label_selects_its_row_not_the_editable_field_or_wrapper_cell() {
        assert_eq!(
            owner(&["AXTextField", "AXCell", "AXRow", "AXOutline"], false).unwrap(),
            Some(2)
        );
        assert_eq!(
            owner(&["AXTextField", "AXCell", "AXTable"], false).unwrap(),
            Some(1)
        );
        assert_eq!(owner(&["AXTextField", "AXOutline"], false).unwrap(), None);
        assert_eq!(owner(&["AXTextField", "AXOutline"], true).unwrap(), None);
        assert_eq!(owner(&["AXButton", "AXList"], true).unwrap(), Some(0));
        assert_eq!(
            owner(&["AXRow", "AXRow", "AXOutline"], true).unwrap(),
            Some(0)
        );
    }

    #[test]
    fn collection_owner_must_reach_the_requested_root_before_delivery() {
        let missing = collection_owner(
            &0,
            &2,
            true,
            |_| Ok((Some("AXRow".into()), None)),
            |left, right| left == right,
        );
        assert_eq!(missing.unwrap_err().code, ErrorCode::AppUnresponsive);
        let mut reads = 0;
        let cycle = collection_owner(
            &0,
            &2,
            true,
            |_| {
                reads += 1;
                Ok((Some("AXRow".into()), Some(0)))
            },
            |left, right| left == right,
        );
        assert_eq!(cycle.unwrap_err().code, ErrorCode::AppUnresponsive);
        assert_eq!(reads, 8);
    }

    #[test]
    fn selection_requires_a_known_canonical_label_and_an_actionable_target() {
        let mut evidence = LocatorEvidence {
            role: LocatorField::Known("treeitem".into()),
            name: LocatorField::Known("Math".into()),
            description: LocatorField::Absent,
            value: LocatorField::Unknown,
            identifiers: IdentifierEvidence::absent(),
            states: LocatorField::Unknown,
            ref_evidence: LocatorRefEvidence {
                window_bounds: LocatorField::Absent,
                bounds: LocatorField::Unknown,
                available_actions: LocatorField::Known(vec!["Click".into()]),
                descriptors: Default::default(),
            },
        };
        assert!(matches_evidence(&evidence, "math").unwrap());
        assert!(!matches_evidence(&evidence, "All").unwrap());
        evidence.ref_evidence.available_actions = LocatorField::Known(vec![]);
        assert!(!matches_evidence(&evidence, "Math").unwrap());
        evidence.ref_evidence.available_actions = LocatorField::Known(vec!["Click".into()]);
        evidence.name = LocatorField::Unknown;
        assert_eq!(
            matches_evidence(&evidence, "Math").unwrap_err().code,
            ErrorCode::AppUnresponsive
        );
    }
}
