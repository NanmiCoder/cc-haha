mod classification {
    use agent_desktop_core::ErrorCode;

    use super::super::{field, read_children};
    use crate::tree::Field;
    use crate::tree::live::test_support::{client_timeout, method_error};
    use crate::tree::properties::absence::{UNKNOWN_INTERFACE, UNKNOWN_METHOD, UNKNOWN_OBJECT};
    use crate::tree::properties::liveness::Liveness;

    #[test]
    fn a_suspect_name_on_a_node_that_answers_stays_on_its_field() {
        for name in [UNKNOWN_OBJECT, UNKNOWN_METHOD, UNKNOWN_INTERFACE] {
            let read: Result<u32, zbus::Error> = Err(method_error(name));
            let outcome = field(read, Liveness::Alive).expect("a live node's read does not fail");
            assert!(outcome.is_failed(), "{name}");
        }
    }

    #[test]
    fn a_suspect_name_on_a_node_whose_role_failed_the_same_way_ends_the_read() {
        let read: Result<u32, zbus::Error> = Err(method_error(UNKNOWN_OBJECT));
        let error = field(read, Liveness::ObjectGone).expect_err("a gone object fails the read");
        assert_eq!(error.code, ErrorCode::ElementNotFound);
    }

    #[test]
    fn an_application_that_left_the_bus_ends_the_read_with_the_walks_present_answer() {
        let read: Result<u32, zbus::Error> = Err(method_error(crate::system::SERVICE_UNKNOWN));
        let error = field(read, Liveness::Alive).expect_err("an exited app fails the read");
        assert_eq!(error.code, ErrorCode::AppNotFound);
    }

    #[test]
    fn a_client_timeout_is_a_failed_field_and_never_an_absence() {
        let read: Result<u32, zbus::Error> = Err(client_timeout());
        let outcome = field(read, Liveness::TimedOut).expect("a timeout keeps the node");
        assert!(matches!(outcome, Field::Failed(_)));
    }

    #[test]
    fn a_child_list_that_fails_on_a_live_node_is_a_failed_field() {
        let outcome = read_children(Err(method_error(UNKNOWN_METHOD)), Liveness::Alive)
            .expect("a live node's child list does not end the read");
        assert!(outcome.is_failed());
    }
}

#[test]
fn snapshot_reads_only_named_properties_without_bulk_or_unadvertised_reads() {
    use crate::tree::AtspiElement;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use zbus::connection::Builder;

    struct Accessible(Arc<AtomicUsize>);
    #[zbus::interface(name = "org.a11y.atspi.Accessible")]
    impl Accessible {
        fn get_role(&self) -> u32 {
            43
        }
        fn get_interfaces(&self) -> Vec<String> {
            vec!["org.a11y.atspi.Accessible".into()]
        }
        #[zbus(property)]
        fn name(&self) -> &str {
            "Save"
        }
        #[zbus(property)]
        fn description(&self) -> &str {
            "Save document"
        }
        #[zbus(property)]
        fn child_count(&self) -> i32 {
            0
        }
        #[zbus(property)]
        fn accessible_id(&self) -> &str {
            "save"
        }
        #[zbus(property)]
        fn unrequested(&self) -> bool {
            self.0.fetch_add(1, Ordering::SeqCst);
            true
        }
    }
    struct Component(Arc<AtomicUsize>);
    #[zbus::interface(name = "org.a11y.atspi.Component")]
    impl Component {
        fn get_extents(&self, _coordinates: u32) -> (i32, i32, i32, i32) {
            self.0.fetch_add(1, Ordering::SeqCst);
            (0, 0, 20, 20)
        }
    }
    struct Action(Arc<AtomicUsize>);
    #[zbus::interface(name = "org.a11y.atspi.Action")]
    impl Action {
        fn get_actions(&self) -> Vec<(String, String, String)> {
            self.0.fetch_add(1, Ordering::SeqCst);
            vec![]
        }
    }
    let forbidden = Arc::new(AtomicUsize::new(0));
    let (near, far) = std::os::unix::net::UnixStream::pair().unwrap();
    let (client, server) = zbus::block_on(futures_lite::future::zip(
        Builder::async_io_unix_stream(near).p2p().build(),
        Builder::async_io_unix_stream(far)
            .server(zbus::Guid::generate())
            .unwrap()
            .p2p()
            .serve_at("/node", Accessible(forbidden.clone()))
            .unwrap()
            .serve_at("/node", Component(forbidden.clone()))
            .unwrap()
            .serve_at("/node", Action(forbidden.clone()))
            .unwrap()
            .build(),
    ));
    let _server = server.unwrap();
    let node = zbus::block_on(super::read_node(
        &client.unwrap(),
        &AtspiElement::new(":1.1", "/node", 1),
    ))
    .unwrap();
    assert_eq!(
        node.properties.name.present().map(String::as_str),
        Some("Save")
    );
    assert_eq!(
        node.properties.description.present().map(String::as_str),
        Some("Save document")
    );
    assert_eq!(node.properties.child_count.present(), Some(&0));
    assert_eq!(
        node.properties.accessible_id.present().map(String::as_str),
        Some("save")
    );
    assert_eq!(
        forbidden.load(Ordering::SeqCst),
        0,
        "bulk property reads or unadvertised interfaces must never be invoked"
    );
}
