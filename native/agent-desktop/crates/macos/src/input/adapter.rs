use agent_desktop_core::{
    AdapterError, ClipboardContent, ClipboardFormat, Deadline, DragParams, InputOps,
    InteractionLease, KeyCombo, MouseEvent, OperationReport,
};

use crate::adapter::MacOSAdapter;

impl InputOps for MacOSAdapter {
    fn mouse_event(
        &self,
        event: MouseEvent,
        lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        let report = crate::input::pointer_report::pointer_report(&event);
        crate::input::mouse::synthesize_mouse(event, lease.deadline())?;
        Ok(report)
    }

    fn key_event(
        &self,
        combo: &KeyCombo,
        down: bool,
        _lease: &InteractionLease,
    ) -> Result<(), AdapterError> {
        crate::input::keyboard::reject_standalone_key_state(combo, down)
    }

    fn drag(
        &self,
        params: DragParams,
        lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        let report = OperationReport::drag_dispatched(&params);
        crate::input::mouse::synthesize_drag(params, lease.deadline())?;
        Ok(report)
    }

    fn clear_clipboard(&self, lease: &InteractionLease) -> Result<OperationReport, AdapterError> {
        crate::input::clipboard::clear(lease.deadline())?;
        Ok(OperationReport::clipboard_written("clipboard-clear", false))
    }

    fn get_clipboard_content(
        &self,
        format: ClipboardFormat,
        deadline: Deadline,
    ) -> Result<Option<ClipboardContent>, AdapterError> {
        crate::input::clipboard::get_content(format, deadline)
    }

    fn set_clipboard_content(
        &self,
        content: &ClipboardContent,
        lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        crate::input::clipboard::set_content(content, lease.deadline())?;
        Ok(OperationReport::clipboard_written("clipboard-set", true))
    }
}
