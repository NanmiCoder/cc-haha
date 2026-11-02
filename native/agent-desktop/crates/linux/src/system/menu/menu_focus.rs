use agent_desktop_core::{AdapterError, Deadline, WindowInfo};

use crate::tree::AtspiElement;
use {super::menu_surface, crate::system::SharedBus};

/// Whether the window's application has an open menu. Only asked when no
/// window claims focus: an open menu holds the keyboard grab for the
/// application that owns it, so its presence is that application's focus.
pub(crate) fn open_for_window(
    bus: &SharedBus,
    window: &WindowInfo,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    let (bus_name, path) = crate::system::window::window_id::decode(&window.id)?;
    open_at(
        bus,
        &AtspiElement::new(bus_name, path, window.pid.get()),
        deadline,
    )
}

pub(crate) fn open_at(
    bus: &SharedBus,
    window: &AtspiElement,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    menu_surface::popups_at(bus, window, deadline).map(|popups| !popups.is_empty())
}
