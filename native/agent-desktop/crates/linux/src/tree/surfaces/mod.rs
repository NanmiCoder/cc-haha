use self::top_level::is_dialog_role;
use super::RawNode;
use super::vocabulary::state_bits::{MODAL, SHOWING, StateBits};

/// A top-level is a sheet when it carries MODAL or has a dialog role and
/// SHOWING. Unread role or state evidence does not establish a sheet.
pub(crate) fn is_sheet(node: &RawNode) -> bool {
    let (Some(&role), Some(words)) = (node.traits.role.present(), node.traits.states.present())
    else {
        return false;
    };
    let bits = StateBits::new(words);
    bits.has(MODAL) || (is_dialog_role(Some(&role)) && bits.has(SHOWING))
}

/// Alert surfaces require a showing ALERT role, including non-modal alerts (L41-11).
pub(crate) fn is_surface(node: &RawNode, surface: agent_desktop_core::SnapshotSurface) -> bool {
    match surface {
        agent_desktop_core::SnapshotSurface::Sheet => is_sheet(node),
        agent_desktop_core::SnapshotSurface::Alert => {
            node.traits.role.present() == Some(&super::vocabulary::role_numbers::ALERT)
                && node
                    .traits
                    .states
                    .present()
                    .is_some_and(|words| StateBits::new(words).has(SHOWING))
        }
        _ => false,
    }
}

pub(super) mod modal_gate;
pub(crate) mod nested_dialog;
#[cfg(test)]
#[path = "surfaces_tests.rs"]
mod tests;
pub(crate) mod top_level;
pub(crate) mod twin_frames;
pub(crate) mod window_extents;
pub(crate) mod window_tie;
