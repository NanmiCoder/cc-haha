use crate::{
    AdapterError, ClipboardContent, ClipboardFormat, Deadline, DragParams, InteractionLease,
    KeyCombo, MouseEvent, OperationReport,
};

/// `get_clipboard`/`set_clipboard` were removed pre-1.0 in favor of
/// `get_clipboard_content`/`set_clipboard_content`; the C ABI
/// (`ad_get_clipboard`/`ad_set_clipboard`) is unaffected.
pub trait InputOps: Send + Sync {
    /// The reason physical pointer delivery cannot happen in this session, if
    /// it cannot. Commands that would aim a cursor ask before any geometry or
    /// actionability work, so a session without pointer input answers at once
    /// instead of spending its wait budget on a gesture it can never send.
    fn physical_pointer_refusal(&self) -> Option<AdapterError> {
        None
    }

    /// Whether a headed keyboard delivery needs the target window activated
    /// first. An adapter whose keys can be delivered without activating
    /// another window (a Wayland session, where the compositor refuses client
    /// activation) answers false, so core skips a window focus the session
    /// cannot grant.
    fn keyboard_needs_window_activation(&self) -> bool {
        true
    }

    fn mouse_event(
        &self,
        _event: MouseEvent,
        _lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        Err(AdapterError::not_supported("mouse_event"))
    }

    fn key_event(
        &self,
        _combo: &KeyCombo,
        _down: bool,
        _lease: &InteractionLease,
    ) -> Result<(), AdapterError> {
        Err(AdapterError::not_supported("key_event"))
    }

    fn drag(
        &self,
        _params: DragParams,
        _lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        Err(AdapterError::not_supported("drag"))
    }

    fn clear_clipboard(&self, _lease: &InteractionLease) -> Result<OperationReport, AdapterError> {
        Err(AdapterError::not_supported("clear_clipboard"))
    }

    /// Reads the requested clipboard representation. Returns `Ok(None)`
    /// when the pasteboard has no data of the requested shape (or, for
    /// `Auto`, no data at all) — a normal, non-error outcome distinct from
    /// `Err(not_supported)`, which means this platform never implements
    /// clipboard reads.
    fn get_clipboard_content(
        &self,
        _format: ClipboardFormat,
        _deadline: Deadline,
    ) -> Result<Option<ClipboardContent>, AdapterError> {
        Err(AdapterError::not_supported("get_clipboard_content"))
    }

    fn set_clipboard_content(
        &self,
        _content: &ClipboardContent,
        _lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        Err(AdapterError::not_supported("set_clipboard_content"))
    }
}

#[cfg(test)]
#[path = "input_tests.rs"]
mod tests;
