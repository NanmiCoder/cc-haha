use agent_desktop_core::{ErrorCode, IdentifierKind};

use super::*;
use crate::tree::element::ancestry::{self, Ancestry};
use crate::tree::live::test_support::{attributes, read_of};
use crate::tree::vocabulary::role_numbers::PUSH_BUTTON;

fn dom_button() -> ObservedRead {
    let mut read = read_of(PUSH_BUTTON, "Save", &["click"]);
    read.node.attributes = attributes(&[("id", "save-button")]);
    read
}

fn element_in(web: bool) -> AtspiElement {
    let mut element = AtspiElement::new(":1.2", "/button", 40);
    let frame = AtspiElement::new(":1.2", "/frame", 40);
    element.set_ancestry(Ancestry::of(Some(frame), None, web));
    element
}

#[test]
fn a_dom_identifier_is_read_below_a_web_document_and_only_there() {
    let read = dom_button();
    let in_web = evidence_for(&read, &element_in(true));
    let kinds: Vec<_> = in_web
        .identifiers
        .identifiers()
        .iter()
        .map(|identifier| identifier.kind)
        .collect();
    assert_eq!(kinds, [IdentifierKind::AxDomIdentifier]);

    let outside = evidence_for(&read, &element_in(false));
    assert!(outside.identifiers.identifiers().is_empty());
    assert!(outside.identifiers.is_complete());
}

#[test]
fn a_handle_with_no_window_frame_is_refused_rather_than_read_with_a_guessed_flag() {
    let bare = AtspiElement::new(":1.2", "/button", 40);
    let error = require_ancestry(&bare).expect_err("no ancestry");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert!(require_ancestry(&element_in(false)).is_ok());
    let frame = AtspiElement::new(":1.2", "/frame", 40);
    assert!(
        require_ancestry(&{
            let mut e = AtspiElement::new(":1.2", "/x", 40);
            e.set_ancestry(ancestry::of_root(&frame));
            e
        })
        .is_ok()
    );
}

#[test]
fn menu_regression_inner_toggle_parent_keeps_its_frame_for_live_reads() {
    use crate::tree::element::ancestry::{self, Ancestry};
    for web in [false, true] {
        let frame = AtspiElement::new(":1.1", "/frame", 7);
        let mut parent = AtspiElement::new(":1.1", "/button", 7);
        parent.set_ancestry(Ancestry::of(Some(frame.clone()), None, web));
        let mut inner = AtspiElement::new(":1.1", "/toggle", 7);
        inner.set_ancestry(ancestry::child(&parent, Some(PUSH_BUTTON)));
        let restored = inner
            .ancestry()
            .button_parent()
            .expect("walked popup opener");
        require_ancestry(&restored).expect("parent live reads must retain their known context");
        assert_eq!(restored, parent);
        assert_eq!(restored.frame(), Some(&frame));
        assert_eq!(restored.in_web_document(), web);
    }
}

#[test]
fn pointer_evidence_reads_bounds_and_state_once_without_children_or_actions() {
    use crate::tree::vocabulary::state_bits::{ENABLED, SHOWING, VISIBLE};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use zbus::connection::Builder;
    #[derive(Default)]
    struct Counts {
        bounds: AtomicUsize,
        state: AtomicUsize,
        children: AtomicUsize,
        actions: AtomicUsize,
    }
    struct Accessible(Arc<Counts>);
    #[zbus::interface(name = "org.a11y.atspi.Accessible")]
    impl Accessible {
        fn get_role(&self) -> u32 {
            crate::tree::vocabulary::role_numbers::LIST
        }
        #[zbus(property)]
        fn child_count(&self) -> i32 {
            2
        }
        fn get_role_name(&self) -> &str {
            "push button"
        }
        fn get_state(&self) -> Vec<u32> {
            self.0.state.fetch_add(1, Ordering::SeqCst);
            crate::tree::live::test_support::words(&[ENABLED, SHOWING, VISIBLE])
        }
        fn get_interfaces(&self) -> Vec<String> {
            vec![
                "org.a11y.atspi.Component".into(),
                "org.a11y.atspi.Action".into(),
                "org.a11y.atspi.Selection".into(),
            ]
        }
        fn get_attributes(&self) -> std::collections::BTreeMap<String, String> {
            std::collections::BTreeMap::new()
        }
        fn get_children(&self) -> Vec<(String, zbus::zvariant::OwnedObjectPath)> {
            self.0.children.fetch_add(1, Ordering::SeqCst);
            Vec::new()
        }
    }
    struct Component(Arc<Counts>);
    #[zbus::interface(name = "org.a11y.atspi.Component")]
    impl Component {
        fn get_extents(&self, _coordinates: u32) -> (i32, i32, i32, i32) {
            self.0.bounds.fetch_add(1, Ordering::SeqCst);
            (10, 20, 30, 40)
        }
    }
    struct Actions(Arc<Counts>);
    #[zbus::interface(name = "org.a11y.atspi.Action")]
    impl Actions {
        fn get_actions(&self) -> Vec<(String, String, String)> {
            self.0.actions.fetch_add(1, Ordering::SeqCst);
            Vec::new()
        }
    }
    let counts = Arc::new(Counts::default());
    let (near, far) = std::os::unix::net::UnixStream::pair().unwrap();
    let (client, server) = zbus::block_on(futures_lite::future::zip(
        Builder::async_io_unix_stream(near).p2p().build(),
        Builder::async_io_unix_stream(far)
            .server(zbus::Guid::generate())
            .unwrap()
            .p2p()
            .serve_at("/button", Accessible(counts.clone()))
            .unwrap()
            .serve_at("/button", Component(counts.clone()))
            .unwrap()
            .serve_at("/button", Actions(counts.clone()))
            .unwrap()
            .build(),
    ));
    let client = client.unwrap();
    let _server = server.unwrap();
    let mut element = AtspiElement::new(":1.1", "/button", 1);
    element.set_ancestry(ancestry::of_root(&element));
    let node = zbus::block_on(read_evidence(&client, &element, ReadPurpose::State)).unwrap();
    assert_eq!(node.evidence.ref_evidence.bounds.known().unwrap().x, 10.0);
    assert!(node.evidence.states.known().is_some());
    assert!(
        node.read.node.children.is_failed(),
        "an omitted field is unknown"
    );
    assert_eq!(counts.bounds.load(Ordering::SeqCst), 1);
    assert_eq!(counts.state.load(Ordering::SeqCst), 1);
    assert_eq!(counts.children.load(Ordering::SeqCst), 0);
    assert_eq!(counts.actions.load(Ordering::SeqCst), 0);
    let bounds = zbus::block_on(read_evidence(&client, &element, ReadPurpose::Bounds)).unwrap();
    assert!(
        bounds.read.node.traits.states.present().is_some(),
        "bounds reads need fresh state to corroborate a detached object"
    );
    assert_eq!(counts.bounds.load(Ordering::SeqCst), 2);
    assert_eq!(counts.state.load(Ordering::SeqCst), 2);
    assert_eq!(counts.children.load(Ordering::SeqCst), 0);
    assert_eq!(counts.actions.load(Ordering::SeqCst), 0);
    let actions = zbus::block_on(read_evidence(&client, &element, ReadPurpose::Actions)).unwrap();
    assert!(
        actions
            .evidence
            .ref_evidence
            .available_actions
            .known()
            .unwrap()
            .iter()
            .any(|action| action == "Select")
    );
    assert_eq!(counts.children.load(Ordering::SeqCst), 0);
    assert_eq!(counts.actions.load(Ordering::SeqCst), 1);
    let element = zbus::block_on(read_evidence(&client, &element, ReadPurpose::Element)).unwrap();
    assert_eq!(element.read.node.properties.child_count.present(), Some(&2));
    assert!(element.read.node.children.is_failed());
    assert_eq!(counts.children.load(Ordering::SeqCst), 0);
    assert_eq!(counts.actions.load(Ordering::SeqCst), 2);
}
