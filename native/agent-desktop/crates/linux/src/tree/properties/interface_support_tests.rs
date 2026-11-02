use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use zbus::connection::Builder;

use crate::tree::AtspiElement;

struct Accessible;

#[zbus::interface(name = "org.a11y.atspi.Accessible")]
impl Accessible {
    fn get_interfaces(&self) -> Vec<&str> {
        vec![]
    }

    fn get_relation_set(&self) -> Vec<(u32, Vec<(String, zbus::zvariant::OwnedObjectPath)>)> {
        vec![(
            2,
            vec![(
                "org.agentdesktop.OptionalFixture".into(),
                "/node".try_into().unwrap(),
            )],
        )]
    }

    #[zbus(property)]
    fn name(&self) -> &str {
        ""
    }
}

struct Component(Arc<AtomicUsize>);

#[zbus::interface(name = "org.a11y.atspi.Component")]
impl Component {
    fn get_extents(&self, _coordinates: u32) -> (i32, i32, i32, i32) {
        self.0.fetch_add(1, Ordering::SeqCst);
        (0, 0, 20, 20)
    }

    fn get_accessible_at_point(
        &self,
        _x: i32,
        _y: i32,
        _coordinates: u32,
    ) -> (String, zbus::zvariant::OwnedObjectPath) {
        self.0.fetch_add(1, Ordering::SeqCst);
        (
            "org.agentdesktop.OptionalFixture".into(),
            "/node".try_into().unwrap(),
        )
    }
}

struct Application(Arc<AtomicUsize>);

#[zbus::interface(name = "org.a11y.atspi.Application")]
impl Application {
    #[zbus(property)]
    fn toolkit_name(&self) -> &str {
        self.0.fetch_add(1, Ordering::SeqCst);
        "Qt"
    }
    #[zbus(property)]
    fn version(&self) -> &str {
        self.0.fetch_add(1, Ordering::SeqCst);
        "6.4.2"
    }
}

struct Text(Arc<AtomicUsize>);

#[zbus::interface(name = "org.a11y.atspi.Text")]
impl Text {
    fn get_text(&self, _start: i32, _end: i32) -> &str {
        self.0.fetch_add(1, Ordering::SeqCst);
        "unsafe label"
    }
    #[zbus(property)]
    fn caret_offset(&self) -> i32 {
        self.0.fetch_add(1, Ordering::SeqCst);
        0
    }
}

#[test]
fn unadvertised_optional_interfaces_receive_no_methods_or_properties() {
    let reads = Arc::new(AtomicUsize::new(0));
    let (near, far) = std::os::unix::net::UnixStream::pair().unwrap();
    let (client, server) = zbus::block_on(futures_lite::future::zip(
        Builder::async_io_unix_stream(near).p2p().build(),
        Builder::async_io_unix_stream(far)
            .server(zbus::Guid::generate())
            .unwrap()
            .p2p()
            .serve_at("/node", Accessible)
            .unwrap()
            .serve_at("/node", Component(reads.clone()))
            .unwrap()
            .serve_at("/node", Application(reads.clone()))
            .unwrap()
            .serve_at("/node", Text(reads.clone()))
            .unwrap()
            .build(),
    ));
    let client = client.unwrap();
    let _server = server.unwrap();
    let node = AtspiElement::new("org.agentdesktop.OptionalFixture", "/node", 1);
    assert_eq!(
        zbus::block_on(crate::system::shell::light::extents_of(&client, &node)),
        None
    );
    {
        use crate::tree::hit_test::hit_descent::{BusNodes, Hit, NodeSource};
        let mut nodes = BusNodes {
            connection: &client,
            deadline: agent_desktop_core::Deadline::after(5_000).unwrap(),
            screen_origin: None,
        };
        assert!(matches!(
            nodes.at_point(&node, (10, 10)).unwrap(),
            Hit::Failed
        ));
    }
    assert_eq!(
        zbus::block_on(
            crate::tree::surfaces::window_extents::read_window_extents_async(&client, &node)
        )
        .unwrap(),
        None
    );
    assert_eq!(
        zbus::block_on(super::super::toolkit_trust::read_toolkit(&client, &node)).unwrap(),
        crate::system::process::toolkit_id::ToolkitId::default()
    );
    assert_eq!(
        zbus::block_on(crate::tree::vocabulary::label_read::read_label(
            &client, &node
        ))
        .unwrap(),
        crate::tree::LabelOutcome::Unlabelled
    );
    let bus = crate::system::bus::tests::connected(client);
    assert_eq!(
        crate::tree::capabilities::text_selection::read_caret_and_selection(
            &bus,
            &node,
            agent_desktop_core::Deadline::after(5_000).unwrap()
        )
        .unwrap(),
        None
    );
    assert_eq!(
        reads.load(Ordering::SeqCst),
        0,
        "unadvertised interfaces must never be queried"
    );
}
