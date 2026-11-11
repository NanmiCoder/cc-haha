use super::window_context::WindowLookup;
use super::window_xid::{XidOutcome, window_xid};
use crate::system::SharedBus;
use agent_desktop_core::{AdapterError, Deadline, DisplayInfo, WindowInfo};

pub(crate) struct BusLookup<'a> {
    pub(crate) bus: &'a SharedBus,
}

impl WindowLookup for BusLookup<'_> {
    fn resolve(&self, window: &WindowInfo, deadline: Deadline) -> Result<WindowInfo, AdapterError> {
        crate::system::resolve_window_strict(self.bus, window, deadline)
    }

    fn xid(&self, window: &WindowInfo, deadline: Deadline) -> XidOutcome {
        window_xid(self.bus, window, deadline)
    }

    fn displays(&self, deadline: Deadline) -> Result<Vec<DisplayInfo>, AdapterError> {
        crate::system::list_displays(deadline)
    }
}
