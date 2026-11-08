use agent_desktop_core::{AdapterError, Deadline, IdentifierKind, NativeHandle, RefEntry};

use super::{TrayTarget, call, identity, menu_layout, menu_resolve};

fn malformed() -> AdapterError {
    AdapterError::stale_ref_because("The ref's tray identity could not be read")
}

pub(super) fn target_of_entry(entry: &RefEntry) -> Result<TrayTarget, AdapterError> {
    entry
        .identity
        .native_id
        .as_ref()
        .filter(|id| id.kind == IdentifierKind::RuntimeId)
        .and_then(|id| identity::decode(&id.value))
        .ok_or_else(malformed)
}

/// Re-identifies a stored tray ref against the live bus. The ref binds the
/// unique bus name, so an owner that left, or a restarted service under the
/// same well-known name, never reaches a process the snapshot did not see.
pub(crate) fn resolve(entry: &RefEntry, deadline: Deadline) -> Result<NativeHandle, AdapterError> {
    let target = target_of_entry(entry)?;
    let connection = call::session(deadline)?;
    call::require_owner(&connection, &target.owner, deadline)?;
    if let Some(menu) = target.menu_path.clone() {
        let layout = menu_layout::read(&connection, &target.owner, &menu, deadline)?;
        menu_resolve::find(&layout, &target)?;
    }
    Ok(NativeHandle::new(target))
}
