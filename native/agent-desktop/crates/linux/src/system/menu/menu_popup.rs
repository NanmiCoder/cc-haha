use crate::system::menu::menu_found::Found;
use crate::tree::surfaces::top_level::is_popup_menu_surface;
use crate::tree::vocabulary::role_numbers::is_web_document;
use crate::tree::vocabulary::role_numbers::{
    CHECK_MENU_ITEM, FILLER, FRAME, MENU, MENU_BAR, PANEL, POPUP_MENU, PUSH_BUTTON,
    RADIO_MENU_ITEM, TOGGLE_BUTTON, WINDOW,
};
use crate::tree::vocabulary::state_bits::{
    CHECKED, EXPANDED, HAS_POPUP, MODAL, PRESSED, SHOWING, StateBits,
};
use crate::tree::{ObservedRead, WalkedNode};

pub(in crate::system) type Node = WalkedNode<ObservedRead>;

const MENU_ITEM: u32 = 35;
const SEPARATOR: u32 = 50;
const ITEM_SEARCH_DEPTH: usize = 12;

/// Where a popup lives in the tree, which decides how its root is found. The
/// family is read from the placement the tree shows, never from the toolkit's
/// name: one toolkit has both an in-window and a top-level placement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MenuFamily {
    Gtk3Bar,
    Gtk3Context,
    Gtk4Popover,
    Gtk3Popover,
    Qt,
    Chromium,
}

impl MenuFamily {
    /// Whether popups of the family are top-level windows of the application
    /// rather than children of the window that opened them.
    pub(crate) fn is_top_level(self) -> bool {
        matches!(self, Self::Gtk3Context | Self::Chromium)
    }
}

fn role(node: &Node) -> Option<u32> {
    node.payload.node.traits.role.present().copied()
}

fn has_state(node: &Node, bit: u32) -> bool {
    node.payload
        .node
        .traits
        .states
        .present()
        .is_some_and(|words| StateBits::new(words).has(bit))
}

fn is_item(role: Option<u32>) -> bool {
    matches!(role, Some(MENU_ITEM | CHECK_MENU_ITEM | RADIO_MENU_ITEM))
}

fn is_menu(role: Option<u32>) -> bool {
    matches!(role, Some(MENU | POPUP_MENU))
}

fn showing_items(node: &Node, depth: usize) -> usize {
    if depth > ITEM_SEARCH_DEPTH {
        return 0;
    }
    node.children
        .iter()
        .map(|child| {
            let child_role = role(child);
            if is_item(child_role) {
                usize::from(has_state(child, SHOWING)) + showing_items(child, depth + 1)
            } else if is_menu(child_role) {
                0
            } else {
                showing_items(child, depth + 1)
            }
        })
        .sum()
}

fn open_menu(node: &Node) -> Option<usize> {
    let open = is_menu(role(node)) && has_state(node, SHOWING);
    open.then(|| showing_items(node, 0))
        .filter(|items| *items > 0)
}

fn collect<'a>(node: &'a Node, in_bar: bool, found: &mut Vec<Found<'a>>) {
    if node.in_web_document || is_web_document(role(node)) {
        return;
    }
    let kind = role(node);
    if let Some(popup) = button_popover(node).or_else(|| toggle_menu(node)) {
        found.push(popup);
        return;
    }
    if let Some(items) = open_menu(node) {
        let family = match kind {
            Some(POPUP_MENU) => MenuFamily::Qt,
            _ if in_bar => MenuFamily::Gtk3Bar,
            _ => MenuFamily::Gtk4Popover,
        };
        found.push(Found {
            root: node,
            family,
            items,
        });
    }
    let in_bar = in_bar || kind == Some(MENU_BAR);
    for child in &node.children {
        collect(child, in_bar, found);
    }
}

fn toggle_menu(node: &Node) -> Option<Found<'_>> {
    if role(node) != Some(TOGGLE_BUTTON)
        || !has_state(node, CHECKED)
        || !has_state(node, SHOWING)
        || !node.children.iter().all(only_menu_content)
    {
        return None;
    }
    let items = showing_items(node, 0);
    (items > 0).then_some(Found {
        root: node,
        items,
        family: MenuFamily::Gtk3Popover,
    })
}

fn showing_buttons(node: &Node, depth: usize) -> usize {
    if depth > ITEM_SEARCH_DEPTH || node.in_web_document {
        return 0;
    }
    node.children
        .iter()
        .map(|child| {
            let own = role(child) == Some(PUSH_BUTTON) && has_state(child, SHOWING);
            usize::from(own) + showing_buttons(child, depth + 1)
        })
        .sum()
}

/// The showing panel of a menu button whose popover is open: the button
/// advertises a popup and is expanded and showing, its inner toggle is
/// pressed, and exactly one of its panels shows. The states alone are what a
/// toolkit can set without opening anything; the panel is the part that exists
/// only while the popover does.
fn opened_button_popover(node: &Node) -> Option<&Node> {
    if role(node) != Some(PUSH_BUTTON)
        || !has_state(node, HAS_POPUP)
        || !has_state(node, EXPANDED)
        || !has_state(node, SHOWING)
        || !node
            .children
            .iter()
            .any(|child| role(child) == Some(TOGGLE_BUTTON) && has_state(child, PRESSED))
    {
        return None;
    }
    let mut panels = node
        .children
        .iter()
        .filter(|child| role(child) == Some(PANEL) && has_state(child, SHOWING));
    let root = panels.next()?;
    panels.next().is_none().then_some(root)
}

fn button_popover(node: &Node) -> Option<Found<'_>> {
    let root = opened_button_popover(node)?;
    let items = showing_buttons(root, 0);
    (items > 0).then_some(Found {
        root,
        items,
        family: MenuFamily::Gtk4Popover,
    })
}

fn has_checked_toggle(node: &Node) -> bool {
    if node.in_web_document || is_web_document(role(node)) {
        return false;
    }
    let checked = role(node) == Some(TOGGLE_BUTTON) && has_state(node, CHECKED);
    checked || node.children.iter().any(has_checked_toggle)
}

fn header_popover(node: &Node) -> Option<(&Node, usize)> {
    if node.in_web_document || is_web_document(role(node)) {
        return None;
    }
    let container = role(node) == Some(PANEL) && has_state(node, MODAL) && has_state(node, SHOWING);
    if container {
        let buttons = showing_buttons(node, 0);
        if buttons > 0 {
            return Some((node, buttons));
        }
    }
    node.children.iter().find_map(header_popover)
}

/// The header-bar popover of GTK 3: a checked toggle in the window and a
/// modal, showing panel with showing buttons. The panel stays in the tree
/// while the popover is closed, so the toggle is what tells a closed popover
/// from an open one, and the panel is what tells it from a toggle that is
/// checked for another reason. A modal panel without the toggle is a dialog.
fn gtk3_popover(frame: &Node) -> Option<Found<'_>> {
    if !has_checked_toggle(frame) {
        return None;
    }
    let (root, items) = header_popover(frame)?;
    Some(Found {
        root,
        family: MenuFamily::Gtk3Popover,
        items,
    })
}

/// The popups open inside one window's tree, outermost first. A menu is open
/// when it shows and one of its items shows: a closed Qt popup and a closed
/// GTK 3 menu keep their nodes with the items cleared, and the menu-bar items
/// of every toolkit show while idle, so neither node presence nor a showing
/// bar item says anything.
pub(in crate::system) fn in_window(frame: &Node) -> Vec<Found<'_>> {
    let mut found = Vec::new();
    collect(frame, false, &mut found);
    if found.is_empty() {
        found.extend(gtk3_popover(frame));
    }
    found
}

/// The roots of the popups open below an opener: the menus `in_window` finds,
/// and when there is none, the open popover of a menu button whose popover
/// holds no menu, such as an explanation or a form. That popover is a popup to
/// verify an opener against and no menu surface, so it has no item count and
/// `in_window` never reports it. An opener that advertises a popup and shows
/// no popover node is never one, whatever its own states say.
pub(in crate::system) fn popup_roots(opener: &Node) -> Vec<&Node> {
    let menus: Vec<&Node> = in_window(opener)
        .into_iter()
        .map(|popup| popup.root)
        .collect();
    if menus.is_empty() {
        return opened_button_popover(opener).into_iter().collect();
    }
    menus
}

fn is_popup_content(role: Option<u32>) -> bool {
    matches!(
        role,
        Some(
            MENU | MENU_BAR
                | MENU_ITEM
                | POPUP_MENU
                | SEPARATOR
                | CHECK_MENU_ITEM
                | RADIO_MENU_ITEM
                | PANEL
                | FILLER
        )
    )
}

pub(in crate::system) fn only_menu_content(node: &Node) -> bool {
    is_popup_content(role(node)) && node.children.iter().all(only_menu_content)
}

fn first_open_menu(node: &Node) -> Option<(&Node, usize)> {
    if let Some(items) = open_menu(node) {
        return Some((node, items));
    }
    node.children.iter().find_map(first_open_menu)
}

pub(in crate::system) fn is_popup_candidate(window: &Node) -> bool {
    let children = window
        .children
        .iter()
        .map(|child| {
            let child_role = role(child)?;
            let menus = if child_role == MENU_BAR {
                if child.truncated
                    || child
                        .child_count
                        .is_some_and(|count| count as usize != child.children.len())
                {
                    return None;
                }
                child
                    .children
                    .iter()
                    .map(role)
                    .collect::<Option<Vec<_>>>()?
            } else {
                Vec::new()
            };
            Some((child_role, menus))
        })
        .collect::<Option<Vec<_>>>();
    !window.truncated
        && window
            .child_count
            .is_none_or(|count| count as usize == window.children.len())
        && is_popup_menu_surface(&window.payload.node, children.as_deref())
}

/// The popup a top-level child of the application root is, when it is one: a
/// nameless showing Component child whose whole subtree is menu content.
/// GTK 3 context menus are such a window and Chromium menus such a frame; a
/// real window has a title or holds something besides menus.
pub(in crate::system) fn top_level(window: &Node) -> Option<Found<'_>> {
    if !is_popup_candidate(window) {
        return None;
    }
    let family = match role(window) {
        Some(WINDOW) => MenuFamily::Gtk3Context,
        Some(FRAME) => MenuFamily::Chromium,
        _ => MenuFamily::Chromium,
    };
    let nameless = window.payload.node.properties.name.is_blank();
    if !nameless || !has_state(window, SHOWING) {
        return None;
    }
    if !window.children.iter().all(only_menu_content) {
        return None;
    }
    let (root, items) = window.children.iter().find_map(first_open_menu)?;
    Some(Found {
        root,
        family,
        items,
    })
}

#[cfg(test)]
#[path = "menu_popup_tests.rs"]
mod tests;
