use agent_desktop_core::adapter::live_element::{
    essential_live_evidence_complete, incomplete_live_evidence, known_actions,
};
use agent_desktop_core::{
    AdapterError, Deadline, DeliverySemantics, ElementState, ErrorCode, EvidenceRequirements,
    LiveElement, LiveIdentity, LocatorField, Rect,
};

use crate::tree::{AXElement, element_bounds::ancestor_viewport};

pub(crate) fn read_element_state(
    element: &AXElement,
    deadline: Deadline,
) -> Result<ElementState, AdapterError> {
    let read = read_live_observation(element, deadline)?;
    let attrs = read.attrs;
    let role = known_role(&read.evidence.role)?;
    element_state_from_attrs(element, attrs, role, ancestor_viewport(element, deadline)?)
}

pub(crate) fn read_live_element(
    element: &AXElement,
    deadline: Deadline,
) -> Result<LiveElement, AdapterError> {
    let read = read_live_observation(element, deadline)?;
    let role = known_role(&read.evidence.role)?;
    let identity = LiveIdentity {
        name: read.evidence.name,
        description: read.evidence.description,
        identifiers: read.evidence.identifiers,
    };
    let available_actions = known_actions(read.evidence.ref_evidence.available_actions)?;
    let attrs = read.attrs;
    let bounds = attrs.bounds;
    let expanded_observed = crate::tree::state_reader::expanded_from_attrs(&attrs).is_some();
    let window_bounds = ancestor_viewport(element, deadline)?;
    let state = element_state_from_attrs(element, attrs, role, window_bounds)?;
    Ok(LiveElement {
        identity,
        states_complete: states_are_complete(&state, expanded_observed),
        state,
        bounds,
        available_actions,
    })
}

pub(crate) fn read_live_actions(
    element: &AXElement,
    deadline: Deadline,
) -> Result<Vec<String>, AdapterError> {
    Ok(read_live_element(element, deadline)?.available_actions)
}

fn read_live_observation(
    element: &AXElement,
    deadline: Deadline,
) -> Result<crate::tree::query::node_read::NodeRead, AdapterError> {
    read_observation_with_recovery(deadline, || read_live_observation_once(element, deadline))
}

fn read_observation_with_recovery<T>(
    deadline: Deadline,
    mut read: impl FnMut() -> Result<T, AdapterError>,
) -> Result<T, AdapterError> {
    for attempt in 0..3 {
        if deadline.is_expired() {
            return Err(deadline.timeout_error());
        }
        match read() {
            Err(error) if attempt < 2 && transient_observation_failure(&error) => {
                if deadline.is_expired() {
                    return Err(error);
                }
                std::thread::sleep(
                    deadline
                        .remaining()
                        .min(std::time::Duration::from_millis(1)),
                );
            }
            result => return result,
        }
    }
    Err(deadline.timeout_error())
}

fn transient_observation_failure(error: &AdapterError) -> bool {
    error.code == ErrorCode::AppUnresponsive
        && error.permits_retry_by_default()
        && error.details.as_ref().is_some_and(|details| {
            details["kind"] == "live_element_evidence"
                && details
                    .pointer("/query_stats/reads/cannot_complete")
                    .and_then(serde_json::Value::as_u64)
                    .is_some_and(|failures| failures > 0)
        })
}

fn read_live_observation_once(
    element: &AXElement,
    deadline: Deadline,
) -> Result<crate::tree::query::node_read::NodeRead, AdapterError> {
    let mut usage = new_usage();
    if !usage.claim_node() {
        return Err(incomplete_live_evidence());
    }
    let mut stats = agent_desktop_core::LocatorStats::default();
    let child_plan =
        crate::tree::query::child_read_plan::ChildReadPlan::load(usage.child_capacity());
    let mut read = crate::tree::query::node_read::read_node(
        element,
        crate::tree::query::node_read_context::NodeReadContext {
            tree: &crate::tree::TreeBuildContext::empty(false),
            stats: &mut stats,
            usage: &mut usage,
            requirements: EvidenceRequirements::snapshot(),
            deadline: crate::tree::locator_deadline::from_operation(deadline)?,
            child_plan,
        },
    )?;
    usage.note_child_demand(read.child_read.total_count, &mut stats);
    usage.claim_edges(read.child_read.elements.len());
    if read.invalid_element {
        return Err(AdapterError::new(
            ErrorCode::StaleRef,
            "Element became invalid while reading live state",
        )
        .with_suggestion("Run 'snapshot' to refresh, then retry with the updated ref.")
        .with_disposition(DeliverySemantics::not_delivered()));
    }
    if deadline.is_expired() {
        return Err(deadline.timeout_error());
    }
    if !essential_live_evidence_complete(&read.evidence) {
        return Err(incomplete_live_evidence().with_details(serde_json::json!({
            "kind": "live_element_evidence",
            "complete": false,
            "query_stats": stats,
        })));
    }
    read.attrs.states.semantic.hidden =
        hidden_state(read.attrs.states.semantic.hidden, &read.evidence.states);
    Ok(read)
}

fn new_usage() -> crate::tree::observation_usage::ObservationUsage {
    crate::tree::observation_usage::ObservationUsage::with_defaults()
}

fn known_role(role: &LocatorField<String>) -> Result<String, AdapterError> {
    role.known().cloned().ok_or_else(incomplete_live_evidence)
}

/// Reports whether the control-state evidence the post-action verifier reads was
/// actually observed. A toggleable role needs a parsable checked value; an
/// expandable role needs an observed expanded or disclosing attribute, because an
/// unread attribute is otherwise indistinguishable from a collapsed control.
pub(crate) fn states_are_complete(state: &ElementState, expanded_observed: bool) -> bool {
    let toggle_ready = !crate::tree::roles::is_toggleable_role(&state.role)
        || state
            .value
            .as_deref()
            .and_then(crate::tree::state_reader::parse_checked_value)
            .is_some();
    let expand_ready = !crate::tree::roles::is_expandable_role(&state.role) || expanded_observed;
    toggle_ready && expand_ready
}

fn element_state_from_attrs(
    element: &AXElement,
    attrs: crate::tree::NodeAttrs,
    role: String,
    window_bounds: Option<Rect>,
) -> Result<ElementState, AdapterError> {
    let is_secure = attrs.role.as_deref() == Some("AXSecureTextField")
        || attrs.subrole.as_deref() == Some("AXSecureTextField");
    let context = crate::tree::state_reader::StateReaderContext {
        focused: None,
        window_bounds,
        is_secure_text: is_secure,
    };
    let states = crate::tree::state_reader::states_from_element(element, &attrs, &role, &context);
    let enabled = Some(attrs.states.enabled);
    let hidden = attrs.states.semantic.hidden;
    let offscreen = crate::tree::state_reader::offscreen(attrs.bounds, window_bounds);
    Ok(ElementState {
        role,
        states,
        value: (!is_secure).then_some(attrs.value).flatten(),
        enabled,
        hidden,
        offscreen,
    })
}

fn hidden_state(reported: Option<bool>, canonical: &LocatorField<Vec<String>>) -> Option<bool> {
    reported.or_else(|| match canonical {
        LocatorField::Known(states) => Some(agent_desktop_core::tree::state::has_state(
            states,
            agent_desktop_core::tree::state::HIDDEN,
        )),
        _ => None,
    })
}

#[cfg(test)]
fn normalized_role(ax_role: Option<&str>, ax_subrole: Option<&str>) -> String {
    ax_role
        .map(|role| crate::tree::roles::ax_role_and_subrole_to_str(role, ax_subrole))
        .unwrap_or("unknown")
        .to_string()
}

#[cfg(test)]
#[path = "post_state_tests.rs"]
mod tests;
