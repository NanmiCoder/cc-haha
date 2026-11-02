use agent_desktop_core::{AdapterError, EvidenceRequirements, LocatorField};

pub(crate) fn resolve_element_name(
    element: &super::AXElement,
    deadline: std::time::Instant,
    usage: &mut super::observation_usage::ObservationUsage,
) -> Result<Option<String>, AdapterError> {
    if !usage.claim_node() {
        return Err(AdapterError::new(
            agent_desktop_core::ErrorCode::AppUnresponsive,
            "Element name resolution exhausted its node budget",
        )
        .with_details(serde_json::json!({
            "kind": "element_name_node_budget",
            "complete": false,
        })));
    }
    let mut stats = agent_desktop_core::LocatorStats::default();
    let child_plan = super::query::child_read_plan::ChildReadPlan::load(usage.child_capacity());
    let read = super::query::node_read::read_node(
        element,
        super::query::node_read_context::NodeReadContext {
            tree: &super::TreeBuildContext::empty(false),
            stats: &mut stats,
            usage,
            requirements: EvidenceRequirements {
                role: true,
                name: true,
                ..EvidenceRequirements::default()
            },
            deadline,
            child_plan,
        },
    )?;
    usage.note_child_demand(read.child_read.total_count, &mut stats);
    usage.claim_edges(read.child_read.elements.len());
    match read.evidence.name {
        LocatorField::Known(name) => Ok(Some(name)),
        LocatorField::Absent => Ok(None),
        LocatorField::Unknown => Err(AdapterError::new(
            agent_desktop_core::ErrorCode::AppUnresponsive,
            "Element name evidence was incomplete",
        )
        .with_details(serde_json::json!({
            "kind": "element_name_incomplete",
            "complete": false,
            "query_stats": stats,
        }))),
    }
}
