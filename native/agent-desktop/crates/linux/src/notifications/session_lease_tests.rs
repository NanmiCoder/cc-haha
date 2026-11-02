use agent_desktop_core::{
    AdapterError, Deadline, InteractionLease, InteractionPolicy, MouseButton, Point, WindowInfo,
    acquire_unix_interaction_lease,
};

use super::Session;
use crate::notifications::fake::{FakeWorld, log, reading, spec};
use crate::notifications::world::ShellWorld;
use crate::system::shell::container::Landmark;
use crate::system::shell::open::Opened;
use crate::system::shell::search::Walk;
use crate::tree::AtspiElement;

struct RetainingWorld(FakeWorld);

impl ShellWorld for RetainingWorld {
    fn require_daemon(&self, deadline: Deadline) -> Result<(), AdapterError> {
        self.0.require_daemon(deadline)
    }

    fn locate(&self, landmark: Landmark, deadline: Deadline) -> Result<AtspiElement, AdapterError> {
        self.0.locate(landmark, deadline)
    }

    fn read(&self, root: &AtspiElement, deadline: Deadline) -> Result<Walk, AdapterError> {
        self.0.read(root, deadline)
    }

    fn open(
        &self,
        policy: InteractionPolicy,
        lease: &InteractionLease,
    ) -> Result<(WindowInfo, Opened), AdapterError> {
        self.0.open(policy, lease)
    }

    fn close(&self, lease: &InteractionLease) -> Result<(), AdapterError> {
        let _retained = lease.duplicate_inheritable_fd()?;
        self.0.close(lease)
    }

    fn is_showing(&self, deadline: Deadline) -> Result<bool, AdapterError> {
        self.0.is_showing(deadline)
    }

    fn click(
        &self,
        node: &AtspiElement,
        button: MouseButton,
        policy: InteractionPolicy,
        lease: &InteractionLease,
    ) -> Result<Point, AdapterError> {
        self.0.click(node, button, policy, lease)
    }
}

#[test]
fn notification_cleanup_retains_the_input_workers_interaction_lease() {
    let world = RetainingWorld(FakeWorld::new(
        &log(),
        vec![reading(&[spec("Mail", "message")])],
    ));
    let lease = acquire_unix_interaction_lease(Deadline::after(30_000).unwrap()).unwrap();
    let session = Session::open(&world, InteractionPolicy::headed(), &lease).unwrap();
    session.finish(Ok(())).expect("owned popup restored");
    assert!(!world.0.showing.get());
}
