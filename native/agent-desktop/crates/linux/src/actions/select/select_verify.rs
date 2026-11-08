use super::select_exclusive::selected_child;
use super::select_identity::verification;
use super::select_search::name_matches;
use crate::actions::context::Target;
use crate::actions::select::handle_of;
use crate::system::SharedBus;
use crate::tree::AtspiElement;
use crate::tree::capabilities::action_read::{NodeView, read_node_view};
use crate::tree::live_read::live_offscreen::toolkit_of;
use crate::tree::properties::toolkit_trust::{combo_name_is_value, combo_selection_is_live};
use crate::tree::vocabulary::role_numbers::COMBO_BOX;
use crate::tree::vocabulary::state_bits::SELECTED;

const OBJECT_REPLACEMENT: char = '\u{fffc}';

/// A select that Gecko applies moves the page's value and fires no `change`
/// or `input` event, so the page's own logic never runs: the state read-back
/// proves the selection and not the application's commit, and the answer is
/// then unverified (L30-43).
pub(in crate::actions) fn commit_unobserved(
    no_change_event: bool,
    verdict: Option<bool>,
) -> Option<bool> {
    if no_change_event && verdict == Some(true) {
        None
    } else {
        verdict
    }
}

pub(in crate::actions) fn says_something(shown: &str) -> bool {
    shown
        .chars()
        .any(|char| !char.is_whitespace() && char != OBJECT_REPLACEMENT)
}

pub(in crate::actions) fn combo_evidence(
    value: Option<&str>,
    name: Option<&str>,
    wanted: &str,
    name_is_value: bool,
) -> Option<bool> {
    if let Some(shown) = value.filter(|shown| says_something(shown)) {
        return Some(name_matches(shown, wanted));
    }
    let name = name.filter(|name| says_something(name))?;
    match (name_matches(name, wanted), name_is_value) {
        (true, _) => Some(true),
        (false, true) => Some(false),
        (false, false) => None,
    }
}

fn combo_value_matches(view: &NodeView, wanted: &str, name_is_value: bool) -> Option<bool> {
    if view.role() != Some(COMBO_BOX) {
        return None;
    }
    combo_evidence(view.value(), view.name(), wanted, name_is_value)
}

fn holder_selection_is_live(holder: &Target<'_>) -> bool {
    holder
        .view()
        .is_ok_and(|view| view.role() == Some(COMBO_BOX))
        && combo_selection_is_live(&toolkit_of(holder.bus, holder.element, holder.deadline))
}

pub(in crate::actions) fn read_verification(
    bus: &SharedBus,
    root: &Target<'_>,
    item: &AtspiElement,
    wanted: &str,
    container: Option<&Target<'_>>,
) -> Option<bool> {
    let name_is_value = combo_name_is_value(&toolkit_of(bus, root.element, root.deadline));
    if let Some(owner) = root.element.ancestry().combo_owner() {
        return read_node_view(bus, &handle_of(&owner), root.deadline)
            .ok()
            .and_then(|view| combo_value_matches(&view, wanted, name_is_value));
    }
    let combo = read_node_view(bus, root.handle, root.deadline)
        .ok()
        .and_then(|view| combo_value_matches(&view, wanted, name_is_value));
    let selected = read_node_view(bus, &handle_of(item), root.deadline)
        .ok()
        .and_then(|view| view.state(SELECTED));
    let child = container
        .filter(|holder| holder_selection_is_live(holder))
        .and_then(selected_child);
    verification(combo, selected, child.as_ref(), item)
}
