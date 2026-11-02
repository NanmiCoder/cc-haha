use agent_desktop_core::{
    AdapterError, Deadline, ElementState, LiveElement, LiveIdentity, LocatorField, Rect,
};

use super::menu_layout::LayoutEntry;
use super::node_evidence::{ITEM_ROLE, identifiers, item_states, name_field};
use super::{TrayTarget, call, capability, item, menu_layout, menu_nodes, menu_resolve};

pub(super) fn entry_state(entry: &LayoutEntry, role: &str, passive: bool) -> ElementState {
    let states = item_states(passive, menu_nodes::states_of(entry));
    ElementState {
        role: role.to_owned(),
        states,
        value: None,
        enabled: Some(entry.enabled),
        hidden: Some(passive),
        offscreen: None,
    }
}

pub(crate) fn element(
    target: &TrayTarget,
    deadline: Deadline,
) -> Result<LiveElement, AdapterError> {
    let connection = call::session(deadline)?;
    call::require_owner(&connection, &target.owner, deadline)?;
    let evidence = item::read(&connection, target, deadline)?;
    let (name, element_state, actions) = if let Some(menu) = target.menu_path.as_deref() {
        let layout = menu_layout::read(&connection, &target.owner, menu, deadline)?;
        let entry = menu_resolve::find(&layout, target)?;
        (
            entry.label.clone(),
            entry_state(entry, menu_nodes::role_of(entry), evidence.passive),
            capability::entry_actions(entry),
        )
    } else {
        (
            evidence.title,
            ElementState {
                role: ITEM_ROLE.to_owned(),
                states: item_states(evidence.passive, Vec::new()),
                value: None,
                enabled: Some(true),
                hidden: Some(evidence.passive),
                offscreen: None,
            },
            capability::actions(&evidence.methods),
        )
    };
    Ok(LiveElement {
        identity: LiveIdentity {
            name: name_field(&name),
            description: LocatorField::Absent,
            identifiers: identifiers(target),
        },
        state: element_state,
        states_complete: true,
        bounds: None,
        available_actions: actions,
    })
}

pub(crate) fn actions(
    target: &TrayTarget,
    deadline: Deadline,
) -> Result<Option<Vec<String>>, AdapterError> {
    element(target, deadline).map(|element| Some(element.available_actions))
}

pub(crate) fn state(
    target: &TrayTarget,
    deadline: Deadline,
) -> Result<Option<ElementState>, AdapterError> {
    element(target, deadline).map(|element| Some(element.state))
}

pub(crate) fn bounds(
    target: &TrayTarget,
    deadline: Deadline,
) -> Result<Option<Rect>, AdapterError> {
    element(target, deadline).map(|element| element.bounds)
}

#[cfg(test)]
#[path = "live_state_tests.rs"]
mod tests;
