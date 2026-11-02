use agent_desktop_core::actions::capability;

use super::scroll_capability::{eligible, wheel_target};
use crate::system::display::display_server::{DisplayServer, session_server};
use crate::tree::properties::node_read::COMPONENT_INTERFACE;
use crate::tree::vocabulary::role_numbers::{
    CHECK_BOX, CHECK_MENU_ITEM, COMBO_BOX, DIAL, ENTRY, LIST, LIST_ITEM, PAGE_TAB, PASSWORD_TEXT,
    PUSH_BUTTON, RADIO_BUTTON, RADIO_MENU_ITEM, SCROLL_BAR, SLIDER, SPIN_BUTTON, TERMINAL, TEXT,
    TOGGLE_BUTTON, is_menu_item,
};
use crate::tree::vocabulary::state_bits::{
    EDITABLE, EXPANDABLE, EXPANDED, FOCUSABLE, HAS_POPUP, READ_ONLY, SELECTABLE, StateBits,
};
use crate::tree::{Field, RawNode};

const VALUE: &str = "org.a11y.atspi.Value";
const TEXT_INTERFACE: &str = "org.a11y.atspi.Text";
const EDITABLE_TEXT: &str = "org.a11y.atspi.EditableText";
const SELECTION: &str = "org.a11y.atspi.Selection";
const TOGGLE_EXPAND: &str = "listitem.toggle-expand";
const EXPAND: &str = "listitem.expand";
const COLLAPSE: &str = "listitem.collapse";
const DISCLOSURE_CLICKS: [&str; 3] = ["click", "press", "activate"];
const TOGGLE_ONLY_NAMES: [&str; 3] = ["toggle", "switch", "uncheck"];
const SHOW_MENU: &str = "showmenu";

/// What the token rules read from a node, every part confirmed. A part whose
/// read failed makes the whole node unknown, never empty: a token the failed
/// read would have decided must not silently be left out.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Facts<'a> {
    pub(crate) role: u32,
    pub(crate) bits: StateBits<'a>,
    pub(crate) interfaces: &'a [String],
    pub(crate) names: &'a [String],
    pub(crate) child_count: Option<i32>,
}

fn interface_decides(role: u32, bits: &StateBits) -> bool {
    is_text_entry(role)
        || is_numeric_control(role)
        || matches!(role, LIST | COMBO_BOX)
        || bits.has(FOCUSABLE)
}

fn confirmed(field: &Field<Vec<String>>) -> Option<&[String]> {
    match field {
        Field::Present(list) => Some(list),
        Field::Absent => Some(&[]),
        Field::Failed(_) => None,
    }
}

impl<'a> Facts<'a> {
    /// The facts of a node, or `None` when the role, the states, the action
    /// names, the interfaces of a role or a focusable node they decide (text,
    /// numeric, list, combo box, and any node that can take focus, whose
    /// `Component` interface decides `SetFocus`) or, on a node that advertises
    /// `Selection`, the child count could not be read. A layout node that
    /// cannot take focus and whose interface list failed keeps the tokens its
    /// names give: no interface could add one it would claim.
    pub(crate) fn of(node: &'a RawNode) -> Option<Self> {
        let role = *node.traits.role.present()?;
        let bits = StateBits::new(node.traits.states.present()?);
        let interfaces = match &node.traits.interfaces {
            Field::Failed(_) if !interface_decides(role, &bits) => &[],
            other => confirmed(other)?,
        };
        let names = confirmed(&node.actions)?;
        let child_count = node.properties.child_count.present().copied();
        let facts = Self {
            role,
            bits,
            interfaces,
            names,
            child_count,
        };
        if facts.advertises(SELECTION) && node.properties.child_count.is_failed() {
            return None;
        }
        Some(facts)
    }

    fn advertises(&self, interface: &str) -> bool {
        self.interfaces.iter().any(|name| name == interface)
    }

    fn has_name(&self, wanted: &str) -> bool {
        self.names
            .iter()
            .any(|name| name.eq_ignore_ascii_case(wanted))
    }

    fn has_any_name(&self, wanted: &[&str]) -> bool {
        wanted.iter().any(|name| self.has_name(name))
    }
}

fn is_text_entry(role: u32) -> bool {
    matches!(role, TEXT | TERMINAL | ENTRY | PASSWORD_TEXT)
}

fn is_numeric_control(role: u32) -> bool {
    matches!(role, SLIDER | SPIN_BUTTON | DIAL | SCROLL_BAR)
}

fn popup_button_children(facts: &Facts) -> bool {
    match facts.child_count {
        Some(1) => true,
        Some(2) => facts.bits.has(EXPANDED),
        _ => false,
    }
}

fn menu_button(facts: &Facts) -> bool {
    facts.role == PUSH_BUTTON
        && facts.bits.has(HAS_POPUP)
        && popup_button_children(facts)
        && !facts.has_any_name(&DISCLOSURE_CLICKS)
}

pub(crate) fn carries_checked(role: u32) -> bool {
    matches!(
        role,
        CHECK_BOX | RADIO_BUTTON | CHECK_MENU_ITEM | RADIO_MENU_ITEM | TOGGLE_BUTTON
    )
}

fn popup_dropdown(facts: &Facts) -> bool {
    facts.role == COMBO_BOX
        && facts.bits.has(HAS_POPUP)
        && !facts.advertises(SELECTION)
        && popup_button_children(facts)
}

/// Whether a combo box offers no route of its own: no popup state to open it
/// by, no `Selection` and no action. Its choices exist in the tree only while
/// a popup that a pointer opened shows, as the combo row of libadwaita does,
/// so a select on it needs the pointer and is delivered only to a headed
/// request.
pub(crate) fn pointer_only_combo(
    role: u32,
    has_popup: bool,
    selection: bool,
    action_names: &[String],
    child_count: i32,
) -> bool {
    role == COMBO_BOX && !has_popup && !selection && action_names.is_empty() && child_count > 0
}

fn pointer_combo(facts: &Facts) -> bool {
    facts.child_count.is_some_and(|count| {
        pointer_only_combo(
            facts.role,
            facts.bits.has(HAS_POPUP),
            facts.advertises(SELECTION),
            facts.names,
            count,
        )
    })
}

/// The tokens that need more than an action name: the text and numeric
/// writes, the disclosure pair, selection, the click of a switch that
/// advertises only a toggle verb and the click of a disabled button, whose
/// toolkit drops the verb a live button would carry. A scroll bar takes `SetValue`
/// on every toolkit and the write is judged by its read-back, because the
/// table has no toolkit input and a Qt bar that does not move content says
/// so when the write is read back. Selectable rows and tabs use their parent's
/// revalidated Selection route (L30-18). A node that can take focus and has a
/// `Component` takes `SetFocus`, whatever names it advertises: the call is
/// `Component.GrabFocus`, which a toolkit may reject when it is made.
pub(crate) fn rule_tokens(facts: &Facts) -> Vec<&'static str> {
    let editable_text = is_text_entry(facts.role)
        && facts.bits.has(EDITABLE)
        && !facts.bits.has(READ_ONLY)
        && facts.advertises(EDITABLE_TEXT);
    let stateful = facts.bits.has(EXPANDABLE) || facts.bits.has(EXPANDED);
    let clickable = facts.has_any_name(&DISCLOSURE_CLICKS);
    let both = (stateful && (clickable || facts.has_name(TOGGLE_EXPAND))) || menu_button(facts);
    let expand = both || (stateful && facts.has_name(EXPAND));
    let collapse = both || (stateful && facts.has_name(COLLAPSE));
    let pressable = facts.role == PUSH_BUTTON || carries_checked(facts.role);
    let rules = [
        (editable_text, capability::SET_VALUE),
        (
            editable_text && facts.advertises(TEXT_INTERFACE),
            capability::TYPE_TEXT,
        ),
        (
            is_numeric_control(facts.role) && facts.advertises(VALUE),
            capability::SET_VALUE,
        ),
        (expand, capability::EXPAND),
        (collapse, capability::COLLAPSE),
        (
            facts.advertises(SELECTION) && facts.child_count.is_some_and(|count| count > 0)
                || matches!(facts.role, LIST_ITEM | PAGE_TAB) && facts.bits.has(SELECTABLE)
                || popup_dropdown(facts)
                || pointer_combo(facts),
            capability::SELECT,
        ),
        (
            carries_checked(facts.role) && facts.has_any_name(&TOGGLE_ONLY_NAMES),
            capability::CLICK,
        ),
        (pressable && facts.bits.is_disabled(), capability::CLICK),
        (
            is_menu_item(facts.role) && facts.has_name(SHOW_MENU),
            capability::CLICK,
        ),
        (
            facts.bits.has(FOCUSABLE) && facts.advertises(COMPONENT_INTERFACE),
            capability::SET_FOCUS,
        ),
    ];
    rules
        .into_iter()
        .filter_map(|(enabled, token)| enabled.then_some(token))
        .collect()
}

/// The tokens a scroll target carries: `Scroll` for a node a wheel at its
/// centre can move, on a session that has a pointer leg. The session is only
/// probed for a node whose role and interfaces already qualify.
pub(crate) fn scroll_tokens(node: &RawNode) -> Vec<&'static str> {
    let (Some(role), Some(interfaces)) =
        (node.traits.role.present(), node.traits.interfaces.present())
    else {
        return Vec::new();
    };
    if !wheel_target(*role, interfaces) {
        return Vec::new();
    }
    scroll_tokens_with(node, &session_server())
}

pub(crate) fn scroll_tokens_with(node: &RawNode, session: &DisplayServer) -> Vec<&'static str> {
    match (node.traits.role.present(), node.traits.interfaces.present()) {
        (Some(role), Some(interfaces)) if eligible(*role, interfaces, session) => {
            vec![capability::SCROLL]
        }
        _ => Vec::new(),
    }
}

#[cfg(test)]
#[path = "capability_rules_tests.rs"]
mod tests;
