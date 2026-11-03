use super::menu_popup::Node;
use crate::tree::live::test_support::{read_of, words};
use crate::tree::vocabulary::state_bits::{EXPANDED, PRESSED};
use crate::tree::{Field, WalkedNode};

pub(in crate::system) const SHOWING: u32 = 25;
pub(in crate::system) const HAS_POPUP: u32 = 42;

pub(in crate::system) const FRAME: u32 = 23;
pub(in crate::system) const WINDOW: u32 = 69;
pub(in crate::system) const PANEL: u32 = 39;
pub(in crate::system) const MENU: u32 = 33;
pub(in crate::system) const MENU_BAR: u32 = 34;
pub(in crate::system) const ITEM: u32 = 35;
pub(in crate::system) const POPUP_MENU: u32 = 41;
pub(in crate::system) const SEPARATOR: u32 = 50;
pub(in crate::system) const CHECK_ITEM: u32 = 8;
pub(in crate::system) const BUTTON: u32 = 43;
pub(in crate::system) const TOGGLE: u32 = 62;
pub(in crate::system) const CHECKED: u32 = 4;
pub(in crate::system) const MODAL: u32 = 16;
pub(in crate::system) const LABEL: u32 = 29;
pub(in crate::system) const DOCUMENT_WEB: u32 = 95;

pub(in crate::system) fn node(role: u32, name: &str, states: &[u32], children: Vec<Node>) -> Node {
    let mut read = read_of(role, name, &[]);
    read.node.traits.interfaces = Field::Present(vec![crate::tree::COMPONENT_INTERFACE.into()]);
    read.node.traits.states = Field::Present(words(states));
    WalkedNode {
        payload: read,
        children,
        truncated: false,
        child_count: None,
        source_index: 0,
        in_web_document: false,
    }
}

pub(in crate::system) fn item(name: &str, showing: bool) -> Node {
    let states: &[u32] = if showing { &[SHOWING] } else { &[] };
    node(ITEM, name, states, Vec::new())
}

pub(in crate::system) fn items(showing: bool) -> Vec<Node> {
    vec![item("Open", showing), item("Save", showing)]
}

pub(in crate::system) fn gtk4_popover(showing: bool) -> Node {
    let scrolled = node(
        PANEL,
        "",
        &[SHOWING],
        vec![node(PANEL, "", &[SHOWING], items(showing))],
    );
    node(MENU, "Main Menu", &[SHOWING], vec![scrolled])
}

pub(in crate::system) fn frame_with(children: Vec<Node>) -> Node {
    node(FRAME, "App", &[SHOWING], children)
}

pub(in crate::system) fn gtk3_bar(showing: bool) -> Node {
    let menu = node(MENU, "File", &[SHOWING], items(showing));
    node(MENU_BAR, "", &[SHOWING], vec![menu])
}

pub(in crate::system) fn qt_bar(popup_showing: bool) -> Node {
    let states: &[u32] = if popup_showing { &[SHOWING] } else { &[] };
    let popup = node(POPUP_MENU, "app", states, items(popup_showing));
    let file = node(ITEM, "File", &[SHOWING], vec![popup]);
    node(MENU_BAR, "", &[SHOWING], vec![file])
}

pub(in crate::system) fn gtk3_context_window() -> Node {
    let menu = node(MENU, "", &[SHOWING], items(true));
    node(WINDOW, "", &[SHOWING], vec![menu])
}

pub(in crate::system) fn chromium_frame() -> Node {
    let menu = node(MENU, "", &[SHOWING], items(true));
    let bar = node(MENU_BAR, "", &[SHOWING], vec![menu]);
    node(FRAME, "", &[SHOWING], vec![bar])
}

/// An expanded menu button whose popover panel holds one label and no button:
/// the popover of an explanation, not of a menu. `showing` is whether the
/// popover and its content show.
pub(in crate::system) fn label_popover_opener(showing: bool) -> Node {
    let states: &[u32] = if showing { &[SHOWING] } else { &[] };
    let label = node(LABEL, "Explains the thing", states, Vec::new());
    let content = node(PANEL, "", states, vec![label]);
    let popover = node(PANEL, "", states, vec![content]);
    let inner = node(TOGGLE, "Open", &[SHOWING, PRESSED], Vec::new());
    node(
        BUTTON,
        "Open",
        &[SHOWING, HAS_POPUP, EXPANDED],
        vec![inner, popover],
    )
}

pub(in crate::system) fn header_toggle(checked: bool) -> Node {
    let states: &[u32] = if checked {
        &[SHOWING, CHECKED]
    } else {
        &[SHOWING]
    };
    node(TOGGLE, "Menu", states, Vec::new())
}

pub(in crate::system) fn header_popover_panel(showing: bool) -> Node {
    let states: &[u32] = if showing { &[SHOWING] } else { &[] };
    let buttons = vec![
        node(BUTTON, "Zoom Out", states, Vec::new()),
        node(BUTTON, "New Window", states, Vec::new()),
    ];
    let inner = node(PANEL, "", states, buttons);
    let container: &[u32] = if showing { &[MODAL, SHOWING] } else { &[MODAL] };
    node(PANEL, "", container, vec![inner])
}
