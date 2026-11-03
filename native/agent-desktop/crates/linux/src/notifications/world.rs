use agent_desktop_core::{
    AdapterError, Deadline, InteractionLease, InteractionPolicy, MouseButton, Point, WindowInfo,
};

use crate::input::physical::target_pointer::click_shell;
use crate::system::SharedBus;
use crate::system::shell::anchor::Anchor;
use crate::system::shell::container::{Landmark, locate_anchor};
use crate::system::shell::identity::find_root;
use crate::system::shell::kinds::ShellKind;
use crate::system::shell::light::LiveNodes;
use crate::system::shell::open::{Opened, close, is_showing, open};
use crate::system::shell::search::{Walk, walk};
use crate::tree::AtspiElement;

/// What the notification code needs from the shell core, so its tests run on fakes.
pub(crate) trait ShellWorld {
    fn require_daemon(&self, deadline: Deadline) -> Result<(), AdapterError>;
    fn locate(&self, landmark: Landmark, deadline: Deadline) -> Result<AtspiElement, AdapterError>;
    fn read(&self, root: &AtspiElement, deadline: Deadline) -> Result<Walk, AdapterError>;
    fn open(
        &self,
        policy: InteractionPolicy,
        lease: &InteractionLease,
    ) -> Result<(WindowInfo, Opened), AdapterError>;
    fn close(&self, lease: &InteractionLease) -> Result<(), AdapterError>;
    fn is_showing(&self, deadline: Deadline) -> Result<bool, AdapterError>;
    fn click(
        &self,
        node: &AtspiElement,
        button: MouseButton,
        policy: InteractionPolicy,
        lease: &InteractionLease,
    ) -> Result<Point, AdapterError>;
}

pub(crate) struct LiveWorld<'a> {
    bus: &'a SharedBus,
}

impl<'a> LiveWorld<'a> {
    pub(crate) fn new(bus: &'a SharedBus) -> Self {
        Self { bus }
    }
}

impl ShellWorld for LiveWorld<'_> {
    fn require_daemon(&self, deadline: Deadline) -> Result<(), AdapterError> {
        crate::system::shell::detect::require_daemon(deadline)
    }

    fn locate(&self, landmark: Landmark, deadline: Deadline) -> Result<AtspiElement, AdapterError> {
        let root = find_root(self.bus, deadline)?;
        let located = locate_anchor(self.bus, &root, Anchor::Landmark(landmark), deadline)?;
        Ok(located.container.element)
    }

    fn read(&self, root: &AtspiElement, deadline: Deadline) -> Result<Walk, AdapterError> {
        let nodes = LiveNodes::new(self.bus.get(deadline)?.inner().clone(), deadline);
        walk(&nodes, root, deadline, &|_| false)
    }

    fn open(
        &self,
        policy: InteractionPolicy,
        lease: &InteractionLease,
    ) -> Result<(WindowInfo, Opened), AdapterError> {
        open(self.bus, ShellKind::MessageList, policy, lease)
    }

    fn close(&self, lease: &InteractionLease) -> Result<(), AdapterError> {
        close(self.bus, ShellKind::MessageList, lease)
    }

    fn is_showing(&self, deadline: Deadline) -> Result<bool, AdapterError> {
        is_showing(self.bus, ShellKind::MessageList, deadline)
    }

    fn click(
        &self,
        node: &AtspiElement,
        button: MouseButton,
        policy: InteractionPolicy,
        lease: &InteractionLease,
    ) -> Result<Point, AdapterError> {
        click_shell(self.bus, node, button, policy, lease)
    }
}
