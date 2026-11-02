use agent_desktop_core::AdapterError;

use super::TrayTarget;
use super::menu_layout::{Layout, LayoutEntry};

fn gone(label: &str) -> AdapterError {
    AdapterError::stale_ref_because(format!(
        "The menu entry '{label}' is no longer in the tray item's menu"
    ))
}

fn replaced(label: &str) -> AdapterError {
    AdapterError::stale_ref_because(format!(
        "The menu entry '{label}' is now a different entry than the one the ref was taken from"
    ))
}

fn ambiguous(label: &str) -> AdapterError {
    AdapterError::ambiguous_target(format!(
        "Several entries at one level of the tray menu are labelled '{label}'"
    ))
}

/// Finds the entry a ref names by walking its label path from the menu root.
/// Repeated labels at one level are ambiguous, a missing label is gone, and a
/// label that now carries another entry id is a different entry: the layout
/// revision alone decides nothing, because a revision moves on every change
/// elsewhere in the menu.
pub(crate) fn find<'a>(
    layout: &'a Layout,
    target: &TrayTarget,
) -> Result<&'a LayoutEntry, AdapterError> {
    let mut level = &layout.root;
    for label in &target.label_path {
        let mut named = level.children.iter().filter(|child| &child.label == label);
        let (Some(entry), None) = (named.next(), named.next()) else {
            return Err(
                if level.children.iter().any(|child| &child.label == label) {
                    ambiguous(label)
                } else {
                    gone(label)
                },
            );
        };
        level = entry;
    }
    let label = target.label_path.last().map_or("", String::as_str);
    if Some(level.id) == target.entry_id {
        Ok(level)
    } else {
        Err(replaced(label))
    }
}

#[cfg(test)]
#[path = "menu_resolve_tests.rs"]
mod tests;
