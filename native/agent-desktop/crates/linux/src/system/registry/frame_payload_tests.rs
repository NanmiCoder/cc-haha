use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use agent_desktop_core::Deadline;
use zbus::connection::Builder;
use zbus::zvariant::OwnedObjectPath;

use super::{RootRead, read_frames};
use crate::tree::{AtspiElement, Extents};

struct Root;

#[zbus::interface(name = "org.a11y.atspi.Accessible")]
impl Root {
    fn get_children(&self) -> Vec<(String, OwnedObjectPath)> {
        vec![(":1.1".into(), "/frame".try_into().unwrap())]
    }
}

struct Frame {
    unused_reads: Arc<AtomicUsize>,
    failed_state: bool,
}

#[zbus::interface(name = "org.a11y.atspi.Accessible")]
impl Frame {
    fn get_role(&self) -> u32 {
        crate::tree::vocabulary::role_numbers::FRAME
    }

    fn get_state(&self) -> zbus::fdo::Result<Vec<u32>> {
        if self.failed_state {
            Err(zbus::fdo::Error::AccessDenied("state unavailable".into()))
        } else {
            Ok(vec![1 << crate::tree::vocabulary::state_bits::ACTIVE])
        }
    }

    fn get_interfaces(&self) -> Vec<String> {
        vec![
            crate::system::ACCESSIBLE_INTERFACE.into(),
            crate::tree::COMPONENT_INTERFACE.into(),
        ]
    }

    #[zbus(property)]
    fn name(&self) -> &str {
        "Frame title"
    }

    async fn get_role_name(&self) -> String {
        self.unused_reads.fetch_add(1, Ordering::SeqCst);
        std::future::pending().await
    }
}

struct Component;

#[zbus::interface(name = "org.a11y.atspi.Component")]
impl Component {
    fn get_extents(&self, _coordinates: u32) -> (i32, i32, i32, i32) {
        (10, 20, 300, 200)
    }
}

#[test]
fn frame_inventory_ignores_stalled_snapshot_payload_but_preserves_failed_state() {
    for failed_state in [false, true] {
        let unused_reads = Arc::new(AtomicUsize::new(0));
        let (client, server) = std::os::unix::net::UnixStream::pair().unwrap();
        let (client, server) = zbus::block_on(futures_lite::future::zip(
            Builder::async_io_unix_stream(client).p2p().build(),
            Builder::async_io_unix_stream(server)
                .server(zbus::Guid::generate())
                .unwrap()
                .p2p()
                .serve_at("/root", Root)
                .unwrap()
                .serve_at(
                    "/frame",
                    Frame {
                        unused_reads: Arc::clone(&unused_reads),
                        failed_state,
                    },
                )
                .unwrap()
                .serve_at("/frame", Component)
                .unwrap()
                .build(),
        ));
        let _server = server.unwrap();
        let bus = crate::system::bus::tests::connected(client.unwrap());
        let root = AtspiElement::new(":1.1", "/root", std::process::id());
        let reads = read_frames(&bus, &[root], Deadline::after(2_000).unwrap()).unwrap();
        assert_eq!(reads.len(), 1);
        let read = &reads[0];
        assert_eq!(
            read.nodes.len(),
            1,
            "a stalled unused field cannot erase the frame"
        );
        assert_eq!(
            read.read,
            if failed_state {
                RootRead::TimedOut
            } else {
                RootRead::Read
            }
        );
        let node = &read.nodes[0];
        assert_eq!(
            node.properties.name.present().map(String::as_str),
            Some("Frame title")
        );
        assert_eq!(
            node.traits.role.present(),
            Some(&crate::tree::vocabulary::role_numbers::FRAME)
        );
        assert_eq!(
            node.extents.present(),
            Some(&Extents {
                x: 10,
                y: 20,
                width: 300,
                height: 200
            })
        );
        assert_eq!(node.traits.states.is_failed(), failed_state);
        assert_eq!(unused_reads.load(Ordering::SeqCst), 0);
    }
}
