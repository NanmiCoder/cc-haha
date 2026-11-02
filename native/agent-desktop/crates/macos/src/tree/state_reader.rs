use agent_desktop_core::Rect;
use agent_desktop_core::tree::state;

use super::{AXElement, NodeAttrs};

pub(crate) struct StateReaderContext<'a> {
    pub focused: Option<&'a AXElement>,
    pub window_bounds: Option<Rect>,
    pub is_secure_text: bool,
}

pub(crate) fn states_from_element(
    el: &AXElement,
    attrs: &NodeAttrs,
    role: &str,
    ctx: &StateReaderContext<'_>,
) -> Vec<String> {
    let mut states = Vec::new();
    if ctx
        .focused
        .is_some_and(|focused| super::properties::capabilities::same_element(el, focused))
        || attrs.states.control.focused == Some(true)
    {
        states.push(state::FOCUSED.into());
    }
    if !attrs.states.enabled {
        states.push(state::DISABLED.into());
    }
    if ctx.is_secure_text {
        states.push(state::SECURE.into());
    }
    if expanded_from_attrs(attrs) == Some(true) {
        states.push(state::EXPANDED.into());
    }
    if super::roles::is_toggleable_role(role) {
        if value_is_checked(attrs.value.as_deref()) {
            states.push(state::CHECKED.into());
        } else if value_is_indeterminate(attrs.value.as_deref()) {
            states.push(state::INDETERMINATE.into());
        }
    }
    if attrs.states.control.selected == Some(true) {
        states.push(state::SELECTED.into());
    }
    if attrs.states.semantic.hidden == Some(true) {
        states.push(state::HIDDEN.into());
    }
    if attrs.states.semantic.busy == Some(true) {
        states.push(state::BUSY.into());
    }
    if attrs.states.semantic.modal == Some(true) {
        states.push(state::MODAL.into());
    }
    if attrs.states.semantic.required == Some(true) {
        states.push(state::REQUIRED.into());
    }
    if role == "button" && value_is_checked(attrs.value.as_deref()) {
        states.push(state::PRESSED.into());
    }
    if attrs.states.control.readonly == Some(true) {
        states.push(state::READONLY.into());
    }
    if offscreen(attrs.bounds, ctx.window_bounds).unwrap_or(false) {
        states.push(state::OFFSCREEN.into());
    }
    states
}

pub(crate) fn expanded_from_attrs(attrs: &NodeAttrs) -> Option<bool> {
    expanded_state(
        attrs.role.as_deref(),
        attrs
            .states
            .control
            .expanded
            .or(attrs.states.control.disclosing),
        attrs.value.as_deref(),
    )
}

pub(crate) fn expanded_state(
    native_role: Option<&str>,
    explicit: Option<bool>,
    value: Option<&str>,
) -> Option<bool> {
    explicit.or_else(|| {
        (native_role == Some("AXDisclosureTriangle"))
            .then(|| value.and_then(parse_checked_value))
            .flatten()
    })
}

pub(crate) fn parse_checked_value(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" | "checked" => Some(true),
        "0" | "false" | "no" | "off" | "unchecked" => Some(false),
        _ => None,
    }
}

fn value_is_checked(value: Option<&str>) -> bool {
    value.and_then(parse_checked_value) == Some(true)
}

fn value_is_indeterminate(value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "2" | "mixed" | "indeterminate"
        )
    })
}

/// `None` when either rectangle is unknown. No macOS element publishes
/// `AXOffscreen`, so this geometry test is the only source of the state and
/// both the canonical state list and the live element read must share it.
pub(crate) fn offscreen(bounds: Option<Rect>, window_bounds: Option<Rect>) -> Option<bool> {
    let (el, win) = bounds.zip(window_bounds)?;
    Some(
        win.width <= 0.0
            || win.height <= 0.0
            || el.x + el.width <= win.x
            || el.x >= win.x + win.width
            || el.y + el.height <= win.y
            || el.y >= win.y + win.height,
    )
}

#[cfg(test)]
#[path = "state_reader_tests.rs"]
mod tests;
