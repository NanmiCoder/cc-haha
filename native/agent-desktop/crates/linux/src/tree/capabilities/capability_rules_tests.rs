use agent_desktop_core::LocatorField;

use super::{Facts, rule_tokens, scroll_tokens, scroll_tokens_with};
use crate::system::display::display_cause::Cause;
use crate::system::display::display_server::DisplayServer;
use crate::system::display::display_unavailable::Unavailable;
use crate::tree::capabilities::action_names::capabilities;
use crate::tree::live::test_support::{read_of, words};
use crate::tree::vocabulary::role_numbers::{
    CHECK_BOX, CHECK_MENU_ITEM, COMBO_BOX, DIAL, ENTRY, LEVEL_BAR, LIST, MENU_ITEM, PANEL,
    PASSWORD_TEXT, PROGRESS_BAR, PUSH_BUTTON, RADIO_MENU_ITEM, SCROLL_BAR, SCROLL_PANE, SLIDER,
    SPIN_BUTTON, TEXT, TOGGLE_BUTTON,
};
use crate::tree::vocabulary::state_bits::{
    EDITABLE, EXPANDABLE, EXPANDED, FOCUSABLE, HAS_POPUP, READ_ONLY, SENSITIVE,
};
use crate::tree::{Field, RawNode};

const LIST_ITEM: u32 = 32;
const VALUE: &str = "org.a11y.atspi.Value";
const TEXT_INTERFACE: &str = "org.a11y.atspi.Text";
const EDITABLE_TEXT: &str = "org.a11y.atspi.EditableText";
const SELECTION: &str = "org.a11y.atspi.Selection";
const COMPONENT: &str = "org.a11y.atspi.Component";

type PolicyRow<'a> = (
    u32,
    &'a [u32],
    &'a [&'a str],
    &'a [&'a str],
    i32,
    &'a [&'a str],
);

fn node(role: u32, states: &[u32], interfaces: &[&str], names: &[&str], children: i32) -> RawNode {
    let mut node = read_of(role, "n", names).node;
    node.traits.states = Field::Present(words(states));
    node.traits.interfaces = Field::Present(interfaces.iter().map(|i| (*i).to_owned()).collect());
    node.properties.child_count = Field::Present(children);
    node
}

fn rule_tokens_for(
    role: u32,
    states: &[u32],
    interfaces: &[&str],
    names: &[&str],
    children: i32,
) -> Vec<&'static str> {
    let raw = node(role, states, interfaces, names, children);
    rule_tokens(&Facts::of(&raw).expect("every read present"))
}

#[test]
fn policy_rows_preserve_rule_tokens() {
    let enabled = [SENSITIVE];
    let editable = [SENSITIVE, EDITABLE];
    let editable_read_only = [SENSITIVE, EDITABLE, READ_ONLY];
    let expanded = [SENSITIVE, EXPANDED];
    let expandable = [SENSITIVE, EXPANDABLE];
    let popup = [SENSITIVE, HAS_POPUP];
    let open_popup = [SENSITIVE, HAS_POPUP, EXPANDED];
    let cases: &[PolicyRow<'_>] = &[
        (
            ENTRY,
            &editable,
            &[EDITABLE_TEXT, TEXT_INTERFACE],
            &[],
            0,
            &["SetValue", "TypeText"],
        ),
        (ENTRY, &editable, &[EDITABLE_TEXT], &[], 0, &["SetValue"]),
        (ENTRY, &editable, &[TEXT_INTERFACE], &[], 0, &[]),
        (
            ENTRY,
            &enabled,
            &[EDITABLE_TEXT, TEXT_INTERFACE],
            &[],
            0,
            &[],
        ),
        (
            PASSWORD_TEXT,
            &editable,
            &[EDITABLE_TEXT, TEXT_INTERFACE],
            &[],
            0,
            &["SetValue", "TypeText"],
        ),
        (
            ENTRY,
            &editable_read_only,
            &[EDITABLE_TEXT, TEXT_INTERFACE],
            &[],
            0,
            &[],
        ),
        (TEXT, &editable, &[EDITABLE_TEXT], &[], 0, &["SetValue"]),
        (
            PUSH_BUTTON,
            &editable,
            &[EDITABLE_TEXT, TEXT_INTERFACE],
            &[],
            0,
            &[],
        ),
        (SLIDER, &enabled, &[VALUE], &[], 0, &["SetValue"]),
        (DIAL, &enabled, &[VALUE], &[], 0, &["SetValue"]),
        (SPIN_BUTTON, &enabled, &[VALUE], &[], 0, &["SetValue"]),
        (SCROLL_BAR, &enabled, &[VALUE], &[], 0, &["SetValue"]),
        (LEVEL_BAR, &enabled, &[VALUE], &[], 0, &[]),
        (PROGRESS_BAR, &enabled, &[VALUE], &[], 0, &[]),
        (SPIN_BUTTON, &enabled, &[], &[], 0, &[]),
        (
            LIST_ITEM,
            &expanded,
            &[],
            &["Activate"],
            0,
            &["Expand", "Collapse"],
        ),
        (
            LIST_ITEM,
            &expandable,
            &[],
            &["listitem.toggle-expand"],
            0,
            &["Expand", "Collapse"],
        ),
        (
            LIST_ITEM,
            &expandable,
            &[],
            &["listitem.expand"],
            0,
            &["Expand"],
        ),
        (
            LIST_ITEM,
            &expandable,
            &[],
            &["listitem.collapse"],
            0,
            &["Collapse"],
        ),
        (LIST_ITEM, &expanded, &[], &["SetFocus"], 0, &[]),
        (
            LIST_ITEM,
            &enabled,
            &[],
            &["activate", "listitem.toggle-expand"],
            0,
            &[],
        ),
        (LIST_ITEM, &expandable, &[], &["clipboard.copy"], 0, &[]),
        (PUSH_BUTTON, &popup, &[], &[], 1, &["Expand", "Collapse"]),
        (
            PUSH_BUTTON,
            &open_popup,
            &[],
            &[],
            2,
            &["Expand", "Collapse"],
        ),
        (PUSH_BUTTON, &open_popup, &[], &[], 3, &[]),
        (PUSH_BUTTON, &popup, &[], &["click"], 1, &[]),
        (PUSH_BUTTON, &popup, &[], &[], 2, &[]),
        (PUSH_BUTTON, &enabled, &[], &[], 1, &[]),
        (PANEL, &popup, &[], &[], 1, &[]),
        (LIST, &enabled, &[SELECTION], &[], 3, &["Select"]),
        (LIST, &enabled, &[SELECTION], &[], 0, &[]),
        (LIST, &enabled, &[], &[], 3, &[]),
        (COMBO_BOX, &popup, &[], &[], 1, &["Select"]),
        (COMBO_BOX, &popup, &[], &[], 3, &[]),
        (COMBO_BOX, &enabled, &[], &[], 1, &["Select"]),
        (COMBO_BOX, &enabled, &[], &[], 0, &[]),
        (COMBO_BOX, &enabled, &[], &["press"], 1, &[]),
        (COMBO_BOX, &enabled, &[SELECTION], &[], 1, &["Select"]),
        (MENU_ITEM, &enabled, &[], &["ShowMenu"], 0, &["Click"]),
        (CHECK_MENU_ITEM, &enabled, &[], &["ShowMenu"], 0, &["Click"]),
        (RADIO_MENU_ITEM, &enabled, &[], &["ShowMenu"], 0, &["Click"]),
        (PUSH_BUTTON, &enabled, &[], &["ShowMenu"], 0, &[]),
        (PUSH_BUTTON, &enabled, &[], &["toggle"], 0, &[]),
        (CHECK_BOX, &enabled, &[], &["toggle"], 0, &["Click"]),
        (CHECK_BOX, &enabled, &[], &["switch"], 0, &["Click"]),
        (CHECK_BOX, &enabled, &[], &["uncheck"], 0, &["Click"]),
        (TOGGLE_BUTTON, &enabled, &[], &["toggle"], 0, &["Click"]),
        (TOGGLE_BUTTON, &enabled, &[], &["switch"], 0, &["Click"]),
        (TOGGLE_BUTTON, &enabled, &[], &["uncheck"], 0, &["Click"]),
    ];
    for &(role, states, interfaces, names, children, expected) in cases {
        assert_eq!(
            rule_tokens_for(role, states, interfaces, names, children),
            expected,
            "role {role} names {names:?}"
        );
    }
    for role in [PUSH_BUTTON, CHECK_BOX] {
        assert_eq!(
            rule_tokens_for(role, &[], &[], &["doDefault"], 0),
            ["Click"]
        );
        assert!(rule_tokens_for(role, &enabled, &[], &["doDefault"], 0).is_empty());
    }
    assert!(rule_tokens_for(PANEL, &[], &[], &["doDefault"], 0).is_empty());
    assert!(rule_tokens_for(PUSH_BUTTON, &[READ_ONLY], &[], &[], 0).is_empty());
    assert_eq!(
        rule_tokens_for(CHECK_MENU_ITEM, &[], &[], &["toggle", "ShowMenu"], 0),
        ["Click", "Click", "Click"]
    );
}

#[test]
fn a_node_that_can_take_focus_and_has_a_component_takes_set_focus_on_any_role() {
    let focusable = [SENSITIVE, FOCUSABLE];
    for role in [PUSH_BUTTON, CHECK_BOX, PANEL, SCROLL_PANE, LIST] {
        assert_eq!(
            rule_tokens_for(role, &focusable, &[COMPONENT], &[], 0),
            ["SetFocus"],
            "role {role}"
        );
    }
    let editable = [SENSITIVE, EDITABLE, FOCUSABLE];
    assert_eq!(
        rule_tokens_for(
            ENTRY,
            &editable,
            &[EDITABLE_TEXT, TEXT_INTERFACE, COMPONENT],
            &[],
            0
        ),
        ["SetValue", "TypeText", "SetFocus"]
    );
}

#[test]
fn set_focus_needs_the_focusable_state() {
    for role in [PUSH_BUTTON, PANEL] {
        assert!(rule_tokens_for(role, &[SENSITIVE], &[COMPONENT], &[], 0).is_empty());
    }
}

#[test]
fn set_focus_needs_the_component_and_no_action_name_stands_in_for_it() {
    for role in [PUSH_BUTTON, PANEL] {
        let focusable = [SENSITIVE, FOCUSABLE];
        assert!(rule_tokens_for(role, &focusable, &[], &[], 0).is_empty());
        assert!(rule_tokens_for(role, &focusable, &[VALUE], &["SetFocus"], 0).is_empty());
    }
}

#[test]
fn a_focusable_node_whose_interfaces_failed_is_unknown_not_missing_set_focus() {
    let mut focusable = node(PANEL, &[SENSITIVE, FOCUSABLE], &[COMPONENT], &["click"], 0);
    focusable.traits.interfaces = Field::Failed("x".to_owned());
    assert_eq!(capabilities(&focusable), LocatorField::Unknown);
    let mut layout = node(PANEL, &[SENSITIVE], &[COMPONENT], &["click"], 0);
    layout.traits.interfaces = Field::Failed("x".to_owned());
    assert_eq!(
        capabilities(&layout),
        LocatorField::Known(vec!["Click".to_owned()])
    );
}

#[test]
fn failed_decision_reads_are_unknown_but_layout_interfaces_are_not() {
    let mut failed_interfaces = node(SLIDER, &[SENSITIVE], &[VALUE], &[], 0);
    failed_interfaces.traits.interfaces = Field::Failed("x".to_owned());
    assert_eq!(capabilities(&failed_interfaces), LocatorField::Unknown);
    let mut failed_actions = node(SLIDER, &[SENSITIVE], &[], &[], 0);
    failed_actions.actions = Field::Failed("x".to_owned());
    assert_eq!(capabilities(&failed_actions), LocatorField::Unknown);
    let mut failed_role = node(PANEL, &[SENSITIVE], &[], &["click"], 0);
    failed_role.traits.role = Field::Failed("x".to_owned());
    assert_eq!(capabilities(&failed_role), LocatorField::Unknown);
    let mut failed_layout_interfaces = node(PANEL, &[SENSITIVE], &[], &["click"], 0);
    failed_layout_interfaces.traits.interfaces = Field::Failed("x".to_owned());
    assert_eq!(
        capabilities(&failed_layout_interfaces),
        LocatorField::Known(vec!["Click".to_owned()])
    );
    let mut selection = node(LIST, &[SENSITIVE], &[SELECTION], &[], 2);
    selection.properties.child_count = Field::Failed("x".to_owned());
    assert_eq!(capabilities(&selection), LocatorField::Unknown);
    let mut unrelated = node(PUSH_BUTTON, &[SENSITIVE], &[], &[], 0);
    unrelated.properties.child_count = Field::Failed("x".to_owned());
    assert_eq!(capabilities(&unrelated), LocatorField::Known(Vec::new()));
}

#[test]
fn scroll_policy_keeps_x11_wayland_and_bounds_gates() {
    let pane = node(SCROLL_PANE, &[SENSITIVE], &[COMPONENT], &[], 0);
    let x11 = DisplayServer::X11(":9".to_owned());
    assert_eq!(scroll_tokens_with(&pane, &x11), ["Scroll"]);
    assert!(scroll_tokens_with(&pane, &DisplayServer::Wayland).is_empty());
    assert!(
        scroll_tokens_with(
            &pane,
            &DisplayServer::Unavailable(Unavailable {
                cause: Cause::NotConfigured,
                detail: String::new(),
            })
        )
        .is_empty()
    );
    assert!(
        scroll_tokens_with(&node(PUSH_BUTTON, &[SENSITIVE], &[COMPONENT], &[], 0), &x11).is_empty()
    );
    assert!(scroll_tokens(&node(SCROLL_PANE, &[SENSITIVE], &[], &[], 0)).is_empty());
    for raw in [
        node(SCROLL_BAR, &[SENSITIVE], &[VALUE], &[], 0),
        node(SCROLL_PANE, &[SENSITIVE], &[SELECTION], &["click"], 5),
    ] {
        assert!(scroll_tokens(&raw).is_empty());
        let LocatorField::Known(tokens) = capabilities(&raw) else {
            panic!("expected known capabilities");
        };
        assert!(!tokens.iter().any(|token| token == "Scroll"));
    }
}
