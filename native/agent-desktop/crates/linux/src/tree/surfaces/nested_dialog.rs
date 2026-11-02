use super::top_level::is_dialog_role;
use crate::tree::vocabulary::role_numbers::is_web_document;
use crate::tree::vocabulary::state_bits::{SHOWING, StateBits};
use crate::tree::{AtspiElement, ObservedRead, WalkedNode};

pub(crate) type Node = WalkedNode<ObservedRead>;

/// A dialog drawn inside its window's tree: a `SHOWING` node with a dialog role
/// below the window, which no listing of top-level windows sees.
pub(crate) struct NestedDialog<'a> {
    pub(crate) element: &'a AtspiElement,
    pub(crate) title: Option<&'a str>,
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

/// A showing node with a dialog role. libadwaita draws its save prompt as an
/// alert inside the window and sets no `MODAL` on it, so the state decides
/// nothing here.
fn is_prompt(node: &Node) -> bool {
    has_state(node, SHOWING) && is_dialog_role(node.payload.node.traits.role.present())
}

fn collect<'a>(
    node: &'a Node,
    found: &mut Vec<NestedDialog<'a>>,
    surface: agent_desktop_core::SnapshotSurface,
) {
    if node.in_web_document || is_web_document(role(node)) {
        return;
    }
    if is_prompt(node) && super::is_surface(&node.payload.node, surface) {
        found.push(NestedDialog {
            element: &node.payload.node.element,
            title: node
                .payload
                .node
                .properties
                .name
                .present()
                .map(String::as_str)
                .filter(|title| !title.is_empty()),
        });
        return;
    }
    for child in &node.children {
        collect(child, found, surface);
    }
}

/// The outermost showing dialogs below a window root, in document order. The
/// root itself is never one: a top-level dialog is a window, and listed as
/// such. A dialog that does not show is not found, whether its node is gone
/// or stays in the tree.
pub(crate) fn find(window: &Node) -> Vec<NestedDialog<'_>> {
    find_surface(window, agent_desktop_core::SnapshotSurface::Sheet)
}

pub(crate) fn find_surface(
    window: &Node,
    surface: agent_desktop_core::SnapshotSurface,
) -> Vec<NestedDialog<'_>> {
    let mut found = Vec::new();
    for child in &window.children {
        collect(child, &mut found, surface);
    }
    found
}

/// Whether the walk left any subtree unread, so a dialog may sit where it did
/// not reach.
pub(crate) fn is_cut_short(node: &Node) -> bool {
    node.truncated
        || node
            .child_count
            .is_some_and(|count| count as usize > node.children.len())
        || node.children.iter().any(is_cut_short)
}

/// A failed role can hide a dialog or a web-document boundary. Only a known
/// dialog role needs state evidence; other nodes' states do not decide
/// discovery.
fn unread_dialog(node: &Node, surface: agent_desktop_core::SnapshotSurface) -> bool {
    if node.in_web_document || is_web_document(role(node)) {
        return false;
    }
    let dialog_like = is_dialog_role(node.payload.node.traits.role.present());
    if role(node).is_none() || (dialog_like && node.payload.node.traits.states.present().is_none())
    {
        return true;
    }
    if is_prompt(node) && super::is_surface(&node.payload.node, surface) {
        return false;
    }
    node.children
        .iter()
        .any(|child| unread_dialog(child, surface))
}

/// Root states also decide whether the top-level window itself is a sheet.
pub(crate) fn is_incomplete(window: &Node) -> bool {
    is_incomplete_surface(window, agent_desktop_core::SnapshotSurface::Sheet)
}

pub(crate) fn is_incomplete_surface(
    window: &Node,
    surface: agent_desktop_core::SnapshotSurface,
) -> bool {
    is_cut_short(window)
        || window.payload.node.traits.states.present().is_none()
        || unread_dialog(window, surface)
}

#[cfg(test)]
#[path = "nested_dialog_tests.rs"]
mod tests;
