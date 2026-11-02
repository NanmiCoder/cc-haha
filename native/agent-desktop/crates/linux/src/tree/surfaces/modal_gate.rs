use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics, ErrorCode};
use serde_json::json;

use crate::tree::AtspiElement;
use crate::tree::live_read::NodeReader;
use crate::tree::vocabulary::state_bits::{MODAL, SHOWING, StateBits};

fn unknown() -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        "Cannot establish whether a modal dialog blocks the target window",
    )
    .with_suggestion("Inspect the application's dialogs, act in the dialog or close it, then refresh the snapshot and retry")
    .with_details(json!({
        "check": "modal",
        "cause": "modal_state_unknown",
        "retryable": false,
        "physical_delivery_started": false,
        "semantic_delivery_started": false,
    }))
    .with_disposition(DeliverySemantics::not_delivered())
}

fn unreadable(error: AdapterError, deadline: Deadline) -> AdapterError {
    if error.code == ErrorCode::Internal {
        return error;
    }
    if error.code == ErrorCode::Timeout && deadline.is_expired() {
        return error;
    }
    unknown().with_platform_detail(format!("{}: {}", error.code.as_str(), error.message))
}

/// A read that ended unfinished because the budget ran out says nothing about
/// whether a modal dialog blocks the target: the wait is over, which is the
/// deadline's own answer. An unfinished read with budget left could not
/// establish the state.
fn cut_short(deadline: Deadline) -> AdapterError {
    if deadline.is_expired() {
        deadline.timeout_error()
    } else {
        unknown()
    }
}

/// Semantic actions can bypass toolkit input grabs. A showing modal in the
/// application blocks targets outside its subtree even when their controls
/// remain enabled. A target whose own window is a showing modal is blocked
/// only by a modal inside that window: the modal windows of an application,
/// such as one save prompt for each unsaved document, answer in any order.
/// Unknown modal membership refuses delivery.
/// Shell surfaces are compositor controls, not application top-level windows.
pub(crate) fn ensure_unblocked(
    reader: &mut impl NodeReader,
    target: &AtspiElement,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    if reader.is_verified_shell(target, deadline) {
        return Ok(());
    }
    let owner = target.menu_owner();
    let frame = owner
        .as_ref()
        .or_else(|| target.frame())
        .ok_or_else(unknown)?;
    let mut windows = reader
        .top_levels(frame, deadline)
        .map_err(|error| unreadable(error, deadline))?;
    windows.sort_by_key(|window| window != frame);
    let mut found_frame = false;
    for mut window in windows {
        window.set_ancestry(crate::tree::element::ancestry::of_root(&window));
        let walk = reader
            .native_tree(&window, deadline)
            .map_err(|error| unreadable(error, deadline))?;
        if !walk.complete || super::nested_dialog::is_cut_short(&walk.root) {
            return Err(cut_short(deadline));
        }
        let holds_frame = contains(&walk.root, frame);
        found_frame |= holds_frame;
        if let Some(dialog) = blocker(&walk.root, owner.as_ref().unwrap_or(target))? {
            return Err(blocked(reader, &dialog));
        }
        if holds_frame && shows_modal(&walk.root).is_ok_and(|modal| modal) {
            return Ok(());
        }
    }
    if !found_frame {
        return Err(unknown());
    }
    Ok(())
}

fn contains(
    node: &crate::tree::WalkedNode<crate::tree::ObservedRead>,
    target: &AtspiElement,
) -> bool {
    &node.payload.node.element == target
        || node.children.iter().any(|child| contains(child, target))
}

fn shows_modal(
    node: &crate::tree::WalkedNode<crate::tree::ObservedRead>,
) -> Result<bool, AdapterError> {
    let words = node
        .payload
        .node
        .traits
        .states
        .present()
        .filter(|words| !words.is_empty())
        .ok_or_else(unknown)?;
    let bits = StateBits::new(words);
    Ok(bits.has(SHOWING) && bits.has(MODAL))
}

/// The showing modal node below `node` that does not hold the target. The
/// walk reads no names, so the caller names the blocker it finds.
fn blocker(
    node: &crate::tree::WalkedNode<crate::tree::ObservedRead>,
    target: &AtspiElement,
) -> Result<Option<AtspiElement>, AdapterError> {
    let raw = &node.payload.node;
    let role = raw.traits.role.present().copied().ok_or_else(unknown)?;
    if crate::tree::vocabulary::role_numbers::is_web_document(Some(role)) {
        return Ok(None);
    }
    if shows_modal(node)? && !contains(node, target) {
        return Ok(Some(raw.element.clone()));
    }
    for child in &node.children {
        if let Some(found) = blocker(child, target)? {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

fn blocked(reader: &mut impl NodeReader, dialog: &AtspiElement) -> AdapterError {
    let named = reader
        .read(dialog)
        .ok()
        .and_then(|read| read.read.node.properties.name.non_blank().cloned());
    let dialog = named.as_deref().unwrap_or("unnamed dialog");
    AdapterError::new(
        ErrorCode::ActionFailed,
        format!("Target window is blocked by modal dialog '{dialog}'"),
    )
    .with_suggestion(format!(
        "Act in the dialog '{dialog}' or close it, then retry the original target"
    ))
    .with_details(json!({
        "check": "modal",
        "cause": "blocked_by_modal_dialog",
        "retryable": false,
        "dialog": dialog,
        "physical_delivery_started": false,
        "semantic_delivery_started": false,
    }))
    .with_disposition(DeliverySemantics::not_delivered())
}

#[cfg(test)]
#[path = "modal_gate_tests.rs"]
mod tests;
