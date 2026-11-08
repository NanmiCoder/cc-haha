use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

use agent_desktop_core::Deadline;

use crate::system::SharedBus;
use crate::tree::AtspiElement;

struct Frame {
    readable: Arc<AtomicBool>,
    children_reads: Arc<AtomicUsize>,
}

#[zbus::interface(name = "org.a11y.atspi.Accessible")]
impl Frame {
    fn get_role(&self) -> zbus::fdo::Result<u32> {
        if self.readable.load(Ordering::SeqCst) {
            Ok(23)
        } else {
            Err(zbus::fdo::Error::AccessDenied("role unreadable".into()))
        }
    }

    fn get_state(&self) -> Vec<u32> {
        vec![2, 0]
    }

    fn get_children(&self) -> Vec<(String, zbus::zvariant::OwnedObjectPath)> {
        self.children_reads.fetch_add(1, Ordering::SeqCst);
        Vec::new()
    }
}

#[test]
#[ignore = "requires scripts/private-session.sh; uses its private accessibility bus"]
fn an_active_state_cannot_authorize_keys_without_a_readable_role() {
    assert!(std::env::var_os("AGENT_DESKTOP_PRIVATE_SESSION").is_some());
    let bus = SharedBus::default();
    let deadline = Deadline::after(5000).unwrap();
    let connection = bus.get(deadline).unwrap();
    let readable = Arc::new(AtomicBool::new(false));
    let children_reads = Arc::new(AtomicUsize::new(0));
    let service = connection.inner().clone();
    zbus::block_on(service.object_server().at(
        "/frame",
        Frame {
            readable: readable.clone(),
            children_reads: children_reads.clone(),
        },
    ))
    .unwrap();
    let frame = AtspiElement::new(
        service.unique_name().unwrap().as_str(),
        "/frame",
        std::process::id(),
    );
    assert_eq!(super::frame_active(&bus, &frame, deadline).unwrap(), None);
    readable.store(true, Ordering::SeqCst);
    assert_eq!(
        super::frame_active(&bus, &frame, deadline).unwrap(),
        Some(true)
    );
    assert_eq!(children_reads.load(Ordering::SeqCst), 0);
}
