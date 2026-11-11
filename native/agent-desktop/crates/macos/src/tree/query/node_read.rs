use agent_desktop_core::{
    AdapterError, ErrorCode, LocatorEvidence, LocatorField, LocatorRefEvidence, LocatorStats,
};
use serde_json::json;

use crate::tree::query::evidence_fields::{description_field, name_field};
use crate::tree::query::node_evidence::{
    identifiers as identifier_evidence, is_transparent_wrapper, option_field,
    unknown as unknown_evidence, update_identifier_stats,
};
use crate::tree::query::node_read_context::NodeReadContext;
use crate::tree::{AXElement, query::child_read::ChildRead};

pub(crate) struct NodeRead {
    pub(crate) attrs: crate::tree::NodeAttrs,
    pub(crate) evidence: LocatorEvidence,
    pub(crate) web_wrapper: bool,
    pub(crate) invalid_element: bool,
    pub(crate) child_read: ChildRead,
}

pub(crate) fn read_node(
    element: &AXElement,
    context: NodeReadContext<'_>,
) -> Result<NodeRead, AdapterError> {
    let NodeReadContext {
        tree,
        stats,
        usage,
        requirements,
        deadline,
        child_plan,
    } = context;
    crate::tree::locator_deadline::remaining(deadline)?;
    let read = crate::tree::properties::element::fetch_node_attrs_with_status_for(
        element,
        requirements,
        deadline,
        usage,
    );
    record_attribute_read(stats, &read.metrics, &read.status);
    stats.semantic_reads.settable_reads += read.metrics.settable_reads;
    stats.reads.health.deadline_exhausted += u64::from(read.metrics.deadline_exhausted);
    stats.traversal.limits.text_hits += read.status.text_truncations;
    if read.status.api_disabled {
        return Err(permission_error("attributes"));
    }
    let identifiers = identifier_evidence(&read.identifiers, requirements.identifiers);
    update_identifier_stats(&identifiers, stats);
    if read.status.invalid_element {
        return Ok(NodeRead {
            attrs: crate::tree::NodeAttrs::default(),
            evidence: unknown_evidence(),
            web_wrapper: false,
            invalid_element: true,
            child_read: ChildRead::empty(false),
        });
    }
    let attrs = read.attrs;
    let role = attrs
        .role
        .as_deref()
        .map(|role| crate::tree::roles::ax_role_and_subrole_to_str(role, attrs.subrole.as_deref()))
        .unwrap_or("unknown")
        .to_string();
    let secure = attrs.role.as_deref() == Some("AXSecureTextField")
        || attrs.subrole.as_deref() == Some("AXSecureTextField");
    let value = (!secure).then(|| attrs.value.clone()).flatten();
    let actions = if let Some(actions) = requirements.ref_evidence.actions.then(|| {
        crate::tree::properties::action_list::read_platform_available_actions(
            element, &role, &attrs, deadline, usage,
        )
    }) {
        stats.reads.counts.action_reads += 1;
        stats.reads.health.cannot_complete += u64::from(actions.cannot_complete);
        stats.reads.health.deadline_exhausted += u64::from(actions.deadline_exhausted);
        stats.semantic_reads.settable_reads += actions.settable_reads;
        if actions.api_disabled {
            return Err(permission_error("actions"));
        }
        if actions.invalid_element {
            return Ok(NodeRead {
                attrs: crate::tree::NodeAttrs::default(),
                evidence: unknown_evidence(),
                web_wrapper: false,
                invalid_element: true,
                child_read: ChildRead::empty(false),
            });
        }
        if actions.complete && !actions.deadline_exhausted && !read.status.scrollbars_unknown() {
            LocatorField::Known(actions.actions)
        } else {
            LocatorField::Unknown
        }
    } else {
        LocatorField::Unknown
    };
    let wrapper_candidate = is_transparent_wrapper(
        attrs.role.as_deref(),
        attrs.subrole.as_deref(),
        &attrs.name_evidence,
        value.as_deref(),
        &identifiers,
        &actions,
    );
    let wants_child_label = (requirements.name || requirements.description)
        && crate::tree::child_labels::should_read_child_label(&role, &attrs.name_evidence);
    let budget = child_plan.max_elements(wrapper_candidate, wants_child_label);
    let child_read = crate::tree::query::child_read::read_children(
        element,
        attrs.role.as_deref(),
        budget,
        deadline,
    );
    stats.reads.counts.child_reads += child_read.status.attempts;
    stats.reads.health.cannot_complete += child_read.status.health.cannot_complete;
    stats.reads.health.native_read_failures += child_read.status.health.native_read_failures;
    stats.reads.health.deadline_exhausted += child_read.status.health.deadline_exhausted;
    stats.traversal.limits.child_count_changes += u64::from(child_read.status.count_changed);
    stats.traversal.limits.child_hits += u64::from(child_read.status.cursor_stalled);
    if child_read.status.api_disabled {
        return Err(permission_error("children"));
    }
    if child_read.status.invalid_element {
        return Ok(NodeRead {
            attrs: crate::tree::NodeAttrs::default(),
            evidence: unknown_evidence(),
            web_wrapper: false,
            invalid_element: true,
            child_read: ChildRead::empty(false),
        });
    }
    let (name_evidence, child_label_complete) = if requirements.name || requirements.description {
        crate::tree::child_labels::complete_name_evidence_with_deadline(
            &attrs,
            &role,
            &child_read.elements,
            deadline,
            crate::tree::child_labels::NameEvidenceSinks {
                stats: &mut *stats,
                usage: &mut *usage,
            },
        )?
    } else {
        (attrs.name_evidence.clone(), true)
    };
    let children_complete =
        child_read.complete && child_label_complete && !unplanned_truncation(&child_read, budget);
    let name_field = if !requirements.name {
        LocatorField::Unknown
    } else {
        name_field(
            &name_evidence,
            &read.status,
            attrs.role.as_deref(),
            children_complete,
        )
    };
    let description_field = if !requirements.description {
        LocatorField::Unknown
    } else {
        description_field(
            &name_evidence,
            &read.status,
            attrs.role.as_deref(),
            children_complete,
        )
    };
    let state_context = crate::tree::state_reader::StateReaderContext {
        focused: tree.focused.as_ref(),
        window_bounds: tree.window_bounds,
        is_secure_text: secure,
    };
    let states = requirements.states.then(|| {
        crate::tree::state_reader::states_from_element(element, &attrs, &role, &state_context)
    });
    let web_wrapper = is_transparent_wrapper(
        attrs.role.as_deref(),
        attrs.subrole.as_deref(),
        &name_evidence,
        value.as_deref(),
        &identifiers,
        &actions,
    );
    let role_field = super::evidence_fields::role_field(
        attrs.role.as_deref(),
        attrs.subrole.as_deref(),
        &read.status,
    );
    let evidence = LocatorEvidence {
        role: role_field,
        name: name_field,
        description: description_field,
        value: if requirements.value {
            option_field(value, read.status.value_unknown())
        } else {
            LocatorField::Unknown
        },
        identifiers: crate::tree::resolve::retained::evidence(element, identifiers),
        states: if !requirements.states || read.status.states_unknown() {
            LocatorField::Unknown
        } else {
            LocatorField::Known(states.unwrap_or_default())
        },
        ref_evidence: LocatorRefEvidence {
            window_bounds: LocatorField::Absent,
            bounds: if requirements.ref_evidence.bounds {
                option_field(tree.bounds_for(attrs.bounds), read.status.bounds_unknown())
            } else {
                LocatorField::Unknown
            },
            available_actions: actions,
            descriptors: Default::default(),
        },
    };
    Ok(NodeRead {
        attrs,
        evidence,
        web_wrapper,
        invalid_element: false,
        child_read,
    })
}

/// A boundary node loads a few children on purpose, only to read a label from
/// them, and reports its real child count separately. Calling that deliberate
/// stop a truncation would mark the node's own name uncertain for doing exactly
/// what the plan asked, and an uncertain name is worse than an absent one: it
/// makes later strict resolution give up instead of matching. Whether the label
/// itself is trustworthy is already answered by the label read.
fn unplanned_truncation(
    child_read: &ChildRead,
    budget: crate::tree::query::child_read_budget::ChildReadBudget,
) -> bool {
    !budget.boundary && child_read.truncated()
}

fn permission_error(phase: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::PermDenied,
        "Accessibility API is disabled while reading live locator evidence",
    )
    .with_suggestion("Grant Accessibility permission, then retry")
    .with_details(json!({ "kind": "locator_api_disabled", "phase": phase }))
}

fn record_attribute_read(
    stats: &mut LocatorStats,
    metrics: &crate::tree::properties::node_attribute_metrics::NodeAttributeMetrics,
    status: &crate::tree::properties::node_attribute_status::NodeAttributeStatus,
) {
    stats.reads.counts.attribute_batches += metrics.batch_reads;
    stats.reads.counts.attributes_requested += metrics.requested_count;
    stats.reads.counts.fallback_reads += metrics.fallback_reads;
    stats.reads.health.cannot_complete += u64::from(status.cannot_complete);
    stats.reads.health.native_read_failures += status.native_read_failures;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_boundary_that_stopped_where_the_plan_said_is_not_a_truncated_read() {
        use crate::tree::query::child_read_budget::ChildReadBudget;

        let mut capped = ChildRead::empty(true);
        capped.total_count = 9;
        capped
            .elements
            .push(crate::tree::AXElement(std::ptr::null_mut()));

        assert!(capped.truncated());
        assert!(
            !unplanned_truncation(
                &capped,
                ChildReadBudget {
                    max_elements: 5,
                    boundary: true
                }
            ),
            "a boundary loads a few children on purpose and reports its real count separately"
        );
        assert!(
            unplanned_truncation(
                &capped,
                ChildReadBudget {
                    max_elements: 5,
                    boundary: false
                }
            ),
            "a read that ran out of budget mid-list leaves the name genuinely uncertain"
        );
    }

    #[test]
    fn attribute_stats_record_actual_batch_and_field_counts() {
        let mut stats = LocatorStats::default();
        let metrics = crate::tree::properties::node_attribute_metrics::NodeAttributeMetrics {
            batch_reads: 1,
            requested_count: 22,
            ..Default::default()
        };

        record_attribute_read(
            &mut stats,
            &metrics,
            &crate::tree::properties::node_attribute_status::NodeAttributeStatus::default(),
        );

        assert_eq!(stats.reads.counts.attribute_batches, 1);
        assert_eq!(stats.reads.counts.attributes_requested, 22);
        assert_eq!(stats.reads.counts.fallback_reads, 0);
    }

    #[test]
    fn cannot_complete_keeps_missing_fields_unknown() {
        let mut stats = LocatorStats::default();
        let metrics = crate::tree::properties::node_attribute_metrics::NodeAttributeMetrics {
            batch_reads: 1,
            requested_count: 22,
            fallback_reads: 22,
            ..Default::default()
        };
        let mut status =
            crate::tree::properties::node_attribute_status::NodeAttributeStatus::default();
        status.record_batch_error(accessibility_sys::kAXErrorCannotComplete);

        record_attribute_read(&mut stats, &metrics, &status);

        assert_eq!(stats.reads.health.cannot_complete, 1);
        assert_eq!(stats.reads.counts.fallback_reads, 22);
        assert_eq!(option_field::<String>(None, true), LocatorField::Unknown);
        assert_eq!(
            option_field(Some("Save".to_string()), true),
            LocatorField::Known("Save".into())
        );
    }
}
