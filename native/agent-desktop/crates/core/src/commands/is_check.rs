use crate::{
    AppError, Rect,
    adapter::{PlatformAdapter, optional_live_read},
    commands::helpers::resolve_ref_with_context,
    context::CommandContext,
    refs::RefEntry,
    tree::element_state::ElementState,
    tree::state::{self, CHECKED, EXPANDED, FOCUSED, SELECTED, VisibilityEvidence},
};
use serde_json::{Value, json};

pub struct IsArgs {
    pub ref_id: String,
    pub property: IsProperty,
}

pub enum IsProperty {
    Visible,
    Enabled,
    Checked,
    Focused,
    Expanded,
    Selected,
}

pub fn execute(
    args: IsArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let (entry, handle) = resolve_ref_with_context(&args.ref_id, adapter, context)?;

    let prop_name = match args.property {
        IsProperty::Visible => "visible",
        IsProperty::Enabled => "enabled",
        IsProperty::Checked => "checked",
        IsProperty::Focused => "focused",
        IsProperty::Expanded => "expanded",
        IsProperty::Selected => "selected",
    };

    let deadline = crate::Deadline::standard()?;
    let live_state = optional_live_read(adapter.get_live_state(&handle, deadline))?;
    let state = live_state
        .clone()
        .unwrap_or_else(|| state_from_ref_entry(&entry));
    let states_from_live = live_state.is_some();

    let (applicable, result) = match args.property {
        IsProperty::Visible => {
            let live_bounds = optional_live_read(adapter.get_element_bounds(&handle, deadline))?;
            if let Some(visible) = visible_without_bounds(live_bounds, live_state.as_ref()) {
                return Ok(visible_answer(&args.ref_id, visible));
            }
            let visibility = VisibilityEvidence {
                bounds: live_bounds.or(entry.geometry.bounds),
                states: state.states.clone(),
                bounds_from_live: live_bounds.is_some(),
                states_from_live,
            };
            (visibility.applicable(), visibility.result())
        }
        IsProperty::Enabled => {
            let enabled = state.enabled;
            (enabled.is_some(), enabled == Some(true))
        }
        IsProperty::Focused => (true, state::has_state(&state.states, FOCUSED)),
        IsProperty::Checked => (
            crate::tree::roles::is_toggleable_role(&entry.identity.role)
                || state::has_state(&state.states, CHECKED)
                || crate::actions::capability::contains_any(
                    &entry.capabilities.available_actions,
                    crate::actions::capability::CHECKED_APPLICABILITY,
                ),
            state::has_state(&state.states, CHECKED),
        ),
        IsProperty::Expanded => (
            crate::tree::roles::is_expandable_role(&entry.identity.role)
                || state::has_state(&state.states, EXPANDED)
                || crate::actions::capability::contains_any(
                    &entry.capabilities.available_actions,
                    crate::actions::capability::EXPANDED_APPLICABILITY,
                ),
            state::has_state(&state.states, EXPANDED),
        ),
        IsProperty::Selected => (true, state::has_state(&state.states, SELECTED)),
    };

    Ok(
        json!({ "property": prop_name, "ref": args.ref_id, "result": result, "applicable": applicable }),
    )
}

/// The actionability gate passes `visible` for a node whose bounds cannot be
/// read once the live state says it is not offscreen; the command answers
/// from that same evidence instead of reporting the property inapplicable.
fn visible_without_bounds(live_bounds: Option<Rect>, live: Option<&ElementState>) -> Option<bool> {
    live.filter(|_| live_bounds.is_none())?
        .visible_without_bounds()
}

fn visible_answer(ref_id: &str, visible: bool) -> Value {
    json!({ "property": "visible", "ref": ref_id, "result": visible, "applicable": true })
}

fn state_from_ref_entry(entry: &RefEntry) -> ElementState {
    ElementState {
        role: entry.identity.role.clone(),
        states: entry.capabilities.states.clone(),
        value: entry.identity.value.clone(),
        enabled: None,
        hidden: None,
        offscreen: None,
    }
}

#[cfg(test)]
#[path = "is_check_tests.rs"]
mod tests;
