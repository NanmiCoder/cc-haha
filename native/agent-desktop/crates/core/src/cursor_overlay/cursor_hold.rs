//! One command at a time per drawn cursor.
//!
//! A session's cursor, or one agent's cursor in a `--multi-agent` session, is
//! a single picture that every command routed to it moves. A ref action moves
//! it toward its target before taking the interaction lease, so two commands
//! sharing it could each move it and then click while it shows the other's
//! target. Holding this lock from that travel until the action's effect has
//! played lets one command at a time use a cursor, while commands for
//! different cursors, such as separate sessions or separate agents, still
//! travel in parallel. Every ref action takes it before the interaction lease
//! and never while holding it, so the two locks cannot deadlock.

use crate::{AdapterError, CommandContext, Deadline, storage::file_lock::FileLock};

/// Takes the lock for the cursor this command draws, waiting for another
/// command using the same cursor until `deadline`. `Ok(None)` when there is no
/// cursor to share: the overlay is off, or the session keeps no state on disk.
pub(crate) fn hold_cursor(
    context: &CommandContext,
    deadline: Deadline,
) -> Result<Option<FileLock>, AdapterError> {
    let Some(session_id) = context
        .session_id()
        .filter(|_| context.cursor_overlay().is_enabled())
    else {
        return Ok(None);
    };
    let Ok(store) = crate::refs::refs_store::RefStore::for_session(Some(session_id)) else {
        return Ok(None);
    };
    if !store.base_dir().is_dir() {
        return Ok(None);
    }
    let directory = store.base_dir().join("cursor");
    crate::storage::private_file_parent::ensure_private(&directory)
        .map_err(|error| AdapterError::internal(format!("cursor lock directory: {error}")))?;
    let name = match super::submit::agent_route(context) {
        Some(agent_id) => format!("agent-{agent_id}.lock"),
        None => "session.lock".to_owned(),
    };
    FileLock::acquire(&directory.join(name), deadline, "agent cursor").map(Some)
}
