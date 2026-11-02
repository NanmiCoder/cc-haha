use agent_desktop_core::{AdapterError, Deadline, NativeHandle};

use crate::system::SharedBus;
use crate::tree::AtspiElement;
use crate::tree::capabilities::action_read::{NodeView, read_node_view};

pub(crate) struct Target<'a> {
    pub(crate) bus: &'a SharedBus,
    pub(crate) handle: &'a NativeHandle,
    pub(crate) element: &'a AtspiElement,
    pub(crate) deadline: Deadline,
}

impl Target<'_> {
    pub(crate) fn view(&self) -> Result<NodeView, AdapterError> {
        read_node_view(self.bus, self.handle, self.deadline)
    }
}
