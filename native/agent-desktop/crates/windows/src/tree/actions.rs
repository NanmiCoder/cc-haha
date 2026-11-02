use agent_desktop_core::{LocatorField, actions::capability};

use super::properties::ElementProperties;
use super::properties::property_ids::TreeProperty;
use super::properties::property_outcome::PropertyOutcome;

/// The pattern-availability properties this module reads to decide whether
/// the read set as a whole succeeded.
///
/// `LegacyAvailable` is deliberately absent from this list. A2-2 measured it
/// `true` on 141 of 141 elements, so its own read succeeding proves nothing
/// about any real affordance - counting it toward "did the reads succeed"
/// would let a tree where every other pattern read failed still report
/// `Known`, which is the same failure shape the rule below forbids for every
/// other property: an action implied by a read that did not actually succeed.
const AFFORDANCE_AVAILABILITY: [TreeProperty; 8] = [
    TreeProperty::InvokeAvailable,
    TreeProperty::ToggleAvailable,
    TreeProperty::ExpandCollapseAvailable,
    TreeProperty::SelectionItemAvailable,
    TreeProperty::ValueAvailable,
    TreeProperty::RangeValueAvailable,
    TreeProperty::ScrollAvailable,
    TreeProperty::ScrollItemAvailable,
];

/// Resolves the available-action list from the read set.
///
/// An action is emitted only for a pattern whose availability implies a
/// specific affordance - `Invoke`, `Toggle`, `ExpandCollapse`,
/// `SelectionItem`, `Value` (gated on not read-only), `RangeValue`, `Scroll`,
/// `ScrollItem`. `LegacyIAccessible` availability is not one of those: A2-2
/// measured it `true` on 141 of 141 elements, so treating it as an affordance
/// would ref-allocate every element in every tree. It contributes exactly one
/// action, `Click`, and only when `LegacyDefaultAction` itself reads as a
/// non-empty string - the gate measured working: button, checkbox and list
/// item non-empty; edit, text and container roles empty.
/// `SetFocus` is emitted truthfully from `IsKeyboardFocusable`, but core
/// already declines to treat a bare `SetFocus` as a primary action, so it can
/// never be the sole reason an element becomes ref-able.
///
/// `Known(vec)` is returned once the read set succeeded, including when the
/// vector is empty - that is the legitimate answer for an inert element.
/// `Unknown` is returned only when every one of the eight affordance
/// availability properties, `LegacyDefaultAction` and `IsKeyboardFocusable`
/// read `Unknown`: nothing was learned about this element's affordances, so
/// there is nothing to report `Known` about. A single failed property among
/// otherwise-successful reads does not void the whole answer - that property
/// simply contributes no affordance, the same way an unread pattern would on
/// a provider that never implemented it.
pub fn resolve_actions(properties: &ElementProperties) -> LocatorField<Vec<String>> {
    if read_set_is_unknown(properties) {
        return LocatorField::Unknown;
    }

    let mut actions = Vec::new();

    if properties.is_true(TreeProperty::InvokeAvailable) {
        push_unique(&mut actions, capability::CLICK);
    }
    if properties.is_true(TreeProperty::ToggleAvailable) {
        push_unique(&mut actions, capability::TOGGLE);
    }
    if properties.is_true(TreeProperty::ExpandCollapseAvailable) {
        push_unique(&mut actions, capability::EXPAND);
        push_unique(&mut actions, capability::COLLAPSE);
    }
    if properties.is_true(TreeProperty::SelectionItemAvailable) {
        push_unique(&mut actions, capability::SELECT);
    }
    if properties.is_true(TreeProperty::ValueAvailable)
        && properties.gated_flag(TreeProperty::ValueIsReadOnly) == Some(false)
    {
        push_unique(&mut actions, capability::SET_VALUE);
    }
    if properties.is_true(TreeProperty::RangeValueAvailable)
        && properties.gated_flag(TreeProperty::RangeValueIsReadOnly) == Some(false)
    {
        push_unique(&mut actions, capability::SET_VALUE);
    }
    if properties.is_true(TreeProperty::ScrollAvailable) {
        push_unique(&mut actions, capability::SCROLL);
    }
    if properties.is_true(TreeProperty::ScrollItemAvailable) {
        push_unique(&mut actions, capability::SCROLL_TO);
    }
    if has_legacy_default_action(properties) {
        push_unique(&mut actions, capability::CLICK);
    }
    if properties.is_true(TreeProperty::IsKeyboardFocusable) {
        push_unique(&mut actions, capability::SET_FOCUS);
    }

    LocatorField::Known(actions)
}

fn read_set_is_unknown(properties: &ElementProperties) -> bool {
    AFFORDANCE_AVAILABILITY
        .iter()
        .all(|property| matches!(properties.get(*property), PropertyOutcome::Unknown))
        && matches!(
            properties.get(TreeProperty::LegacyDefaultAction),
            PropertyOutcome::Unknown
        )
        && matches!(
            properties.get(TreeProperty::IsKeyboardFocusable),
            PropertyOutcome::Unknown
        )
}

fn has_legacy_default_action(properties: &ElementProperties) -> bool {
    properties
        .get(TreeProperty::LegacyDefaultAction)
        .non_blank_text()
        .is_some()
}

fn push_unique(actions: &mut Vec<String>, action: &str) {
    if !actions.iter().any(|existing| existing == action) {
        actions.push(action.to_string());
    }
}

#[cfg(test)]
#[path = "actions_tests.rs"]
mod tests;
