use super::*;
use crate::tree::live::test_support::read_of;

fn node(x: i32, y: i32, children: Vec<WalkedNode<ObservedRead>>) -> WalkedNode<ObservedRead> {
    let mut payload = read_of(1, "n", &[]);
    payload.node.extents = Field::Present(Extents {
        x,
        y,
        width: 10,
        height: 10,
    });
    WalkedNode {
        payload,
        children,
        truncated: false,
        child_count: None,
        source_index: 0,
        in_web_document: false,
    }
}

fn gtk4() -> ToolkitId {
    ToolkitId {
        name: Some("GTK".to_owned()),
        version: Some("4.14.5".to_owned()),
    }
}

fn window(x: i32, y: i32) -> Option<Extents> {
    Some(Extents {
        x,
        y,
        width: 10,
        height: 10,
    })
}

fn extents_of(node: &WalkedNode<ObservedRead>) -> Option<(i32, i32)> {
    match &node.payload.node.extents {
        Field::Present(extents) => Some((extents.x, extents.y)),
        _ => None,
    }
}

fn rect_of(node: &WalkedNode<ObservedRead>) -> Option<(i32, i32, i32, i32)> {
    match &node.payload.node.extents {
        Field::Present(extents) => Some((extents.x, extents.y, extents.width, extents.height)),
        _ => None,
    }
}

fn moved_to(x: i32, y: i32) -> Option<FramePlace> {
    Some(FramePlace {
        origin: (x, y),
        drawn: None,
    })
}

fn drawn_at(x: i32, y: i32, width: i32, height: i32) -> Option<FramePlace> {
    Some(FramePlace {
        origin: (x, y),
        drawn: Some(Extents {
            x,
            y,
            width,
            height,
        }),
    })
}

fn sized(width: i32, height: i32) -> Option<Extents> {
    Some(Extents {
        x: 0,
        y: 0,
        width,
        height,
    })
}

fn window_frame() -> AtspiElement {
    let mut frame = AtspiElement::new(":1.1", "/frame", 1);
    frame.set_ancestry(crate::tree::element::ancestry::of_root(&frame.clone()));
    frame
}

fn below(frame: &AtspiElement, path: &str) -> AtspiElement {
    let mut element = AtspiElement::new(":1.1", path, 1);
    element.set_ancestry(crate::tree::element::ancestry::child(frame, None));
    element
}

fn node_of(
    element: AtspiElement,
    children: Vec<WalkedNode<ObservedRead>>,
) -> WalkedNode<ObservedRead> {
    let mut walked = node(0, 0, children);
    walked.payload.node.element = element;
    walked
}

#[test]
fn a_gtk4_node_is_placed_at_its_window_rectangle_moved_to_the_client_origin() {
    let mut root = node(0, 0, vec![node(0, 0, Vec::new())]);
    apply(
        &mut root,
        &gtk4(),
        moved_to(460, 165),
        &[window(0, 0), window(180, 46)],
    );
    assert_eq!(extents_of(&root), Some((460, 165)));
    assert_eq!(extents_of(&root.children[0]), Some((640, 211)));
}

#[test]
fn a_gtk4_menu_uses_the_owning_popup_origin_for_pointer_bounds() {
    let mut menu = node(0, 0, vec![node(0, 0, Vec::new())]);
    apply(
        &mut menu,
        &gtk4(),
        moved_to(730, 410),
        &[window(0, 0), window(26, 38)],
    );

    assert_eq!(extents_of(&menu), Some((730, 410)));
    assert_eq!(extents_of(&menu.children[0]), Some((756, 448)));
}

#[test]
fn a_window_root_is_placed_at_the_rectangle_its_client_draws_not_at_the_size_the_toolkit_kept() {
    let frame = window_frame();
    let mut root = node_of(
        frame.clone(),
        vec![node_of(below(&frame, "/frame/1"), Vec::new())],
    );

    apply(
        &mut root,
        &gtk4(),
        drawn_at(66, 32, 1214, 768),
        &[sized(700, 520), window(180, 46)],
    );

    assert_eq!(rect_of(&root), Some((66, 32, 1214, 768)));
    assert_eq!(rect_of(&root.children[0]), Some((246, 78, 10, 10)));
    assert_eq!(
        root.payload.evidence_bounds,
        Some((sized(700, 520).expect("rect"), BoundsSpace::Window))
    );
}

#[test]
fn a_window_root_the_toolkit_gave_no_rectangle_takes_the_one_its_client_draws() {
    let mut root = node_of(window_frame(), Vec::new());

    apply(&mut root, &gtk4(), drawn_at(66, 32, 1214, 768), &[None]);

    assert_eq!(rect_of(&root), Some((66, 32, 1214, 768)));
}

#[test]
fn a_window_root_whose_client_draws_no_rectangle_keeps_the_toolkit_size_at_the_client_origin() {
    let mut root = node_of(window_frame(), Vec::new());

    apply(&mut root, &gtk4(), moved_to(66, 32), &[sized(700, 520)]);

    assert_eq!(rect_of(&root), Some((66, 32, 700, 520)));
}

#[test]
fn a_root_below_the_window_keeps_its_own_rectangle_moved_to_the_client_origin() {
    let frame = window_frame();
    let mut root = node_of(below(&frame, "/frame/1"), Vec::new());

    apply(
        &mut root,
        &gtk4(),
        drawn_at(66, 32, 1214, 768),
        &[window(30, 40)],
    );

    assert_eq!(rect_of(&root), Some((96, 72, 10, 10)));
}

#[test]
fn without_a_client_origin_a_node_keeps_its_window_rectangle_as_reference_evidence() {
    let mut root = node(0, 0, vec![node(0, 0, Vec::new())]);
    apply(&mut root, &gtk4(), None, &[window(1, 2), window(180, 46)]);
    assert_eq!(extents_of(&root), None);
    assert_eq!(extents_of(&root.children[0]), None);
    assert_eq!(
        root.children[0].payload.evidence_bounds,
        Some((window(180, 46).expect("rect"), BoundsSpace::Window))
    );
}

#[test]
fn a_client_origin_keeps_a_screen_position_and_the_window_rectangle_as_reference_evidence() {
    let mut root = node(0, 0, Vec::new());
    apply(&mut root, &gtk4(), moved_to(460, 165), &[window(1, 2)]);
    assert_eq!(extents_of(&root), Some((461, 167)));
    assert_eq!(
        root.payload.evidence_bounds,
        Some((window(1, 2).expect("rect"), BoundsSpace::Window))
    );
}

#[test]
fn a_node_whose_window_rectangle_was_not_read_loses_its_position() {
    let mut root = node(0, 0, vec![node(0, 0, Vec::new())]);
    apply(
        &mut root,
        &gtk4(),
        moved_to(460, 165),
        &[window(0, 0), None],
    );
    assert_eq!(extents_of(&root), Some((460, 165)));
    assert_eq!(extents_of(&root.children[0]), None);
}

#[test]
fn a_node_off_every_screen_consumes_no_window_rectangle() {
    let mut root = node(
        0,
        0,
        vec![node(i32::MIN, i32::MIN, Vec::new()), node(0, 0, Vec::new())],
    );
    apply(
        &mut root,
        &gtk4(),
        moved_to(100, 100),
        &[window(0, 0), window(5, 6)],
    );
    assert_eq!(extents_of(&root.children[0]), Some((i32::MIN, i32::MIN)));
    assert_eq!(extents_of(&root.children[1]), Some((105, 106)));
}

#[test]
fn placed_elements_follow_the_order_apply_consumes_them_in() {
    let frame = window_frame();
    let first = below(&frame, "/frame/first");
    let nested = below(&frame, "/frame/nested");
    let deepest = below(&frame, "/frame/deepest");
    let mut off_screen = node_of(below(&frame, "/frame/off"), Vec::new());
    off_screen.payload.node.extents = Field::Present(Extents {
        x: i32::MIN,
        y: i32::MIN,
        width: 10,
        height: 10,
    });
    let mut root = node_of(
        first.clone(),
        vec![
            off_screen,
            node_of(nested.clone(), vec![node_of(deepest.clone(), Vec::new())]),
        ],
    );
    assert_eq!(placed_elements(&mut root), vec![first, nested, deepest]);
}

struct UnavailableGeometry;

struct GeometryInterfaces;

#[zbus::interface(name = "org.a11y.atspi.Accessible")]
impl GeometryInterfaces {
    fn get_interfaces(&self) -> Vec<&str> {
        vec!["org.a11y.atspi.Component", "org.a11y.atspi.Application"]
    }
}

#[zbus::interface(name = "org.a11y.atspi.Component")]
impl UnavailableGeometry {
    fn get_extents(&self, _coordinates: u32) -> zbus::fdo::Result<(i32, i32, i32, i32)> {
        Err(zbus::fdo::Error::NotSupported("no geometry".into()))
    }
}

#[test]
fn placement_readers_preserve_transport_loss_and_allow_unavailable_geometry() {
    use zbus::connection::Builder;
    let (near, far) = std::os::unix::net::UnixStream::pair().unwrap();
    let (client, server) = zbus::block_on(futures_lite::future::zip(
        Builder::async_io_unix_stream(near).p2p().build(),
        Builder::async_io_unix_stream(far)
            .server(zbus::Guid::generate())
            .unwrap()
            .p2p()
            .serve_at("/missing", GeometryInterfaces)
            .unwrap()
            .serve_at("/missing", UnavailableGeometry)
            .unwrap()
            .build(),
    ));
    let client = client.unwrap();
    let _server = server.unwrap();
    let element = AtspiElement::new("org.agentdesktop.GeometryFixture", "/missing", 1);
    assert_eq!(
        zbus::block_on(window_rectangles(&client, std::slice::from_ref(&element))).unwrap(),
        [None],
        "a method refusal is unknown geometry"
    );
    assert_eq!(
        zbus::block_on(read_toolkit(&client, &element)).unwrap(),
        ToolkitId::default(),
        "unavailable toolkit properties remain unknown"
    );
    zbus::block_on(client.clone().close()).unwrap();
    let extents = zbus::block_on(window_rectangles(&client, std::slice::from_ref(&element)))
        .expect_err("a broken transport cannot become unknown geometry");
    let toolkit = zbus::block_on(read_toolkit(&client, &element))
        .expect_err("a broken transport cannot become an unknown toolkit");
    let frame = zbus::block_on(frame_facts(&client, &element))
        .expect_err("a broken transport cannot become an unknown frame");
    for error in [extents, toolkit, frame] {
        assert_eq!(error.code, ErrorCode::Internal);
        assert!(error.platform_detail.is_some());
    }
}

#[test]
fn failed_window_geometry_remains_unknown_after_placement() {
    let mut root = node(0, 0, Vec::new());
    apply(&mut root, &gtk4(), moved_to(100, 100), &[None]);
    let evidence = crate::tree::observe::node_evidence::evidence_for(
        &root.payload,
        &root.payload.node.element,
    );
    assert!(evidence.ref_evidence.window_bounds.is_unknown());
    assert!(evidence.ref_evidence.bounds.is_unknown());
}

#[test]
fn a_placement_timeout_cannot_authorize_or_refute_raw_coordinate_evidence() {
    use crate::tree::live::test_support::{rect, ref_entry};
    use crate::tree::resolve::resolve_identity::admit_node;
    use crate::tree::walk::admission::Admission;
    let bus = SharedBus::default();
    let deadline = Deadline::standard()
        .unwrap()
        .capped(std::time::Duration::ZERO);
    let mut read = read_of(crate::tree::vocabulary::role_numbers::PUSH_BUTTON, "", &[]);
    place_single(&bus, &mut read, deadline).unwrap();
    let evidence = crate::tree::observe::node_evidence::evidence_for(&read, &read.node.element);
    assert!(evidence.ref_evidence.bounds.is_unknown());
    assert!(evidence.ref_evidence.window_bounds.is_unknown());
    for space in [BoundsSpace::Window, BoundsSpace::Screen] {
        let mut entry = ref_entry("button");
        entry.geometry.bounds = Some(rect(0.0, 0.0, 10.0, 10.0));
        entry.geometry.bounds_space = Some(space);
        assert_eq!(admit_node(&entry, &evidence), Admission::Unread);
    }
}

#[test]
fn only_sentinel_positions_are_not_placed() {
    for (x, y, width, height, expected) in [
        (0, 0, 10, 10, true),
        (-10, -1, 10, 10, true),
        (0, 0, 0, 10, true),
        (0, 0, 10, -1, true),
        (i32::MIN, 0, 10, 10, false),
        (0, i32::MIN, 10, 10, false),
    ] {
        let mut root = node(x, y, vec![]);
        root.payload.node.extents = Field::Present(Extents {
            x,
            y,
            width,
            height,
        });
        assert_eq!(!placed_elements(&mut root).is_empty(), expected);
    }
}
