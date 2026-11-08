use crate::system::process::toolkit_id::ToolkitId;
use crate::system::shell::container::MENU;
use crate::tree::properties::toolkit_trust::{ToolkitKind, kind};
use crate::tree::vocabulary::role_numbers::PANEL;

/// L32-43: the GTK4 menu frame belongs to an override-redirect popup,
/// independently of whether its node is marked as an action target.
pub(crate) fn uses_popup_origin(role: Option<u32>, toolkit: &ToolkitId, menu_target: bool) -> bool {
    (role == Some(MENU) || menu_target && role == Some(PANEL)) && kind(toolkit) == ToolkitKind::Gtk4
}

#[cfg(test)]
#[path = "popup_frame_tests.rs"]
mod tests;
