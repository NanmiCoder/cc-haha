use agent_desktop_core::{LocatorField, tree::roles, tree::state};

use super::properties::ElementProperties;
use super::properties::property_ids::TreeProperty;
use super::properties::property_outcome::PropertyOutcome;

/// `STATE_SYSTEM_HASPOPUP`, the MSAA bit A15-6 measured on a menu item
/// alongside `STATE_SYSTEM_FOCUSABLE`. Neither `haspopup` nor `busy` has a UI
/// Automation property of its own, so this legacy bitmask is their only
/// source on Windows.
const STATE_SYSTEM_HASPOPUP: i32 = 0x4000_0000;

/// `STATE_SYSTEM_BUSY`, the bit A15-6 measured alone on a plain text control.
const STATE_SYSTEM_BUSY: i32 = 0x0000_0800;

/// `STATE_SYSTEM_PRESSED`, the MSAA bit for a button in pressed state.
const STATE_SYSTEM_PRESSED: i32 = 0x0000_0008;

const TOGGLE_STATE_ON: i32 = 1;
const TOGGLE_STATE_INDETERMINATE: i32 = 2;

const EXPAND_COLLAPSE_STATE_EXPANDED: i32 = 1;

/// Ungated sources the walk always requests for every node. If every one of
/// these reads back `Unknown`, nothing about this element was actually read -
/// that is the shape `ElementProperties::get` produces for a property nobody
/// ever supplied a `(TreeProperty, PropertyOutcome)` entry for.
const READ_HEALTH_PROBES: [TreeProperty; 6] = [
    TreeProperty::IsEnabled,
    TreeProperty::IsOffscreen,
    TreeProperty::HasKeyboardFocus,
    TreeProperty::IsRequiredForForm,
    TreeProperty::IsPassword,
    TreeProperty::LegacyState,
];

/// Resolves the state vocabulary from the read set and the resolved role.
///
/// # `invalid` is deliberately unproduced, and the dogfood run is why
///
/// Microsoft's ARIA state table gives `IsDataValidForForm` as the source, and
/// the first implementation read it that way. Run against four real targets it
/// emitted `invalid` on **every node of every one of them** - 26 of 26 on
/// Notepad, 113 of 113 on Explorer - on static text, title bars, windows and
/// menus alike.
///
/// `false` is that property's *default*, not an assertion. It means no form
/// rule declares the element valid, which is true of everything that is not a
/// form field. `IsRequiredForForm` shares the default and is safe only because
/// `required` is emitted on `true`, a positive claim; `invalid` read the
/// default as a claim and so decorated the whole tree. The property cannot
/// distinguish "not applicable" from "invalid" on any stack measured here, so
/// it is not read at all and `invalid` stays unproduced rather than faked -
/// the correct outcome for a token whose platform source turns out unusable.
///
/// # `pressed` is produced from `LegacyIAccessibleState`
///
/// A `button` role with the `STATE_SYSTEM_PRESSED` bit set in its
/// `LegacyIAccessibleState` emits the `pressed` state. This covers the toolbar
/// toggle button, which was measured advertising no `TogglePattern` at all -
/// only `Invoke` and `LegacyIAccessible` - and carrying its pressed state in
/// the legacy bit alone. `roles.rs`'s `button_role`
/// reclassifies `Button` controls that advertise `ToggleAvailable` to
/// `Role::Switch`, so toggle buttons surface as `switch` + `checked` on
/// Windows. A `button` role reaching this function with the `STATE_SYSTEM_PRESSED`
/// bit set represents a different pattern: a button whose pressed state is
/// exposed through the legacy MSAA interface rather than through UI Automation
/// patterns. macOS's `state_reader.rs` emits `pressed` for toggle buttons in
/// the same logical pattern (role `button` + checked value).
///
/// # Known vs Unknown
/// `LocatorField::Unknown` is returned only when every [`READ_HEALTH_PROBES`]
/// source came back `PropertyOutcome::Unknown` too - the shape a property
/// nobody ever read produces. That means the state read itself never
/// happened, which is not the same fact as "this element carries no states",
/// so it must not be reported as an empty `Known` vector. A single probe that
/// came back `Known` or `Absent` is proof the batch reached this element, and
/// from that point an empty vector is a legitimate, positive answer.
pub fn resolve_states(
    properties: &ElementProperties,
    role: &LocatorField<String>,
) -> LocatorField<Vec<String>> {
    if read_health_failed(properties) {
        return LocatorField::Unknown;
    }

    let role = role.known().map(String::as_str).unwrap_or_default();
    let mut states = Vec::new();

    if properties.get(TreeProperty::IsEnabled).flag() == Some(false) {
        states.push(state::DISABLED.to_string());
    }
    if properties.get(TreeProperty::IsPassword).flag() == Some(true) {
        states.push(state::SECURE.to_string());
    }
    if properties.get(TreeProperty::IsOffscreen).flag() == Some(true) {
        states.push(state::OFFSCREEN.to_string());
    }
    if properties.get(TreeProperty::HasKeyboardFocus).flag() == Some(true) {
        states.push(state::FOCUSED.to_string());
    }
    if properties.get(TreeProperty::IsRequiredForForm).flag() == Some(true) {
        states.push(state::REQUIRED.to_string());
    }

    push_toggle_state(properties, role, &mut states);
    push_expand_collapse_state(properties, &mut states);

    if properties.gated_flag(TreeProperty::SelectionItemIsSelected) == Some(true) {
        states.push(state::SELECTED.to_string());
    }
    if properties.gated_flag(TreeProperty::ValueIsReadOnly) == Some(true) {
        states.push(state::READONLY.to_string());
    }
    if properties.gated_flag(TreeProperty::SelectionCanSelectMultiple) == Some(true) {
        states.push(state::MULTISELECTABLE.to_string());
    }
    if properties.gated_flag(TreeProperty::WindowIsModal) == Some(true) {
        states.push(state::MODAL.to_string());
    }

    push_legacy_state(properties, role, &mut states);

    LocatorField::Known(states)
}

fn read_health_failed(properties: &ElementProperties) -> bool {
    READ_HEALTH_PROBES
        .iter()
        .all(|property| matches!(properties.get(*property), PropertyOutcome::Unknown))
}

/// `ToggleState`, role-gated exactly as macOS's `state_reader.rs:35-41` gates
/// the same source for `checked`/`indeterminate` on a toggleable role.
/// `state_reader.rs:57-59`'s sibling `pressed` arm has no counterpart here;
/// see `resolve_states`'s doc comment for why the role that arm needs can
/// never reach this function.
fn push_toggle_state(properties: &ElementProperties, role: &str, states: &mut Vec<String>) {
    let Some(toggle) = properties.gated_number(TreeProperty::ToggleState) else {
        return;
    };
    if roles::is_toggleable_role(role) {
        match toggle {
            TOGGLE_STATE_ON => states.push(state::CHECKED.to_string()),
            TOGGLE_STATE_INDETERMINATE => states.push(state::INDETERMINATE.to_string()),
            _ => {}
        }
    }
}

/// `ExpandCollapseState`. `LeafNode` is a fourth value this vocabulary does
/// not model as a token: it means the pattern is implemented but the node
/// never expands, which is neither `expanded` nor a collapsed state.
fn push_expand_collapse_state(properties: &ElementProperties, states: &mut Vec<String>) {
    let Some(value) = properties.gated_number(TreeProperty::ExpandCollapseState) else {
        return;
    };
    if value == EXPAND_COLLAPSE_STATE_EXPANDED {
        states.push(state::EXPANDED.to_string());
    }
}

/// `LegacyIAccessibleState`, the Windows source for `pressed`, `haspopup`, and
/// `busy`. Microsoft's ARIA state table records neither `haspopup` nor `busy`
/// has a UI Automation property of its own. A15-6 measured the bitmask as
/// readable and discriminating between those two bits. The `STATE_SYSTEM_PRESSED`
/// bit covers toolbar toggle buttons that do not advertise `ToggleAvailable`.
fn push_legacy_state(properties: &ElementProperties, role: &str, states: &mut Vec<String>) {
    let Some(bits) = properties.get(TreeProperty::LegacyState).number() else {
        return;
    };
    if role == "button" && bits & STATE_SYSTEM_PRESSED != 0 {
        states.push(state::PRESSED.to_string());
    }
    if bits & STATE_SYSTEM_HASPOPUP != 0 {
        states.push(state::HASPOPUP.to_string());
    }
    if bits & STATE_SYSTEM_BUSY != 0 {
        states.push(state::BUSY.to_string());
    }
}

#[cfg(test)]
#[path = "states_tests.rs"]
mod tests;

/// Split from `states_tests.rs`, which sits near the per-file line cap: this
/// module owns the per-source token table, which pins each producer to the
/// token it emits rather than asking only whether the emitted tokens are
/// vocabulary members.
#[cfg(test)]
#[path = "states_tokens_tests.rs"]
mod token_tests;

#[cfg(test)]
#[path = "states_walk_tests.rs"]
mod walk_tests;
