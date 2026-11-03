use agent_desktop_core::{AdapterError, Deadline, ProcessIdentity};

#[cfg(target_os = "macos")]
pub(crate) fn wait_for_menu(
    process: ProcessIdentity,
    open: bool,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    use crate::tree::surfaces::is_menu_open;
    use std::time::Duration;

    loop {
        let identity = crate::system::process::process_identity::require_core(&process)?;
        let instant = crate::tree::locator_deadline::from_operation(deadline)?;
        if is_menu_open(identity.pid(), instant)? == open {
            crate::system::process::process_identity::require_core(&process)?;
            return Ok(());
        }
        if deadline.is_expired() {
            let message = if open {
                "No context menu opened before the deadline"
            } else {
                "Context menu did not close before the deadline"
            };
            return Err(deadline.timeout_error().with_platform_detail(message));
        }
        let pause = deadline.remaining_slice(Duration::from_millis(50))?;
        std::thread::sleep(pause);
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn wait_for_menu(
    _process: ProcessIdentity,
    _open: bool,
    _deadline: Deadline,
) -> Result<(), AdapterError> {
    Err(AdapterError::not_supported("wait_for_menu"))
}
