use super::every_window_hidden;
use crate::system::x11::X11Client;

fn client(pid: u32, hidden: bool) -> X11Client {
    X11Client {
        shadow: (0, 0, 0, 0),
        id: 1,
        pid: Some(pid),
        title: String::new(),
        extents: None,
        bounds: None,
        hidden,
    }
}

#[test]
fn an_app_whose_every_window_is_hidden_is_hidden() {
    assert!(every_window_hidden(&[client(7, true), client(7, true)], 7));
}

#[test]
fn one_visible_window_or_no_window_of_the_app_is_not_hidden() {
    assert!(!every_window_hidden(
        &[client(7, true), client(7, false)],
        7
    ));
    assert!(!every_window_hidden(&[client(8, true)], 7));
    assert!(!every_window_hidden(&[], 7));
}

struct Accessible(bool);

#[zbus::interface(name = "org.a11y.atspi.Accessible")]
impl Accessible {
    fn get_interfaces(&self) -> Vec<&str> {
        if self.0 {
            vec!["org.a11y.atspi.Value"]
        } else {
            vec![]
        }
    }
}

struct Value(std::sync::Arc<std::sync::atomic::AtomicUsize>);

#[zbus::interface(name = "org.a11y.atspi.Value")]
impl Value {
    #[zbus(property)]
    fn minimum_value(&self) -> f64 {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        0.0
    }
    #[zbus(property)]
    fn maximum_value(&self) -> f64 {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        100.0
    }
    #[zbus(property)]
    fn current_value(&self) -> f64 {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        50.0
    }
}

#[test]
fn a_scroll_range_reads_only_advertised_value_properties() {
    use super::BusPort;
    use crate::actions::scroll::scroll_into_view::ScrollPort;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use zbus::connection::Builder;

    for advertised in [false, true] {
        let reads = Arc::new(AtomicUsize::new(0));
        let (near, far) = std::os::unix::net::UnixStream::pair().unwrap();
        let (client, server) = zbus::block_on(futures_lite::future::zip(
            Builder::async_io_unix_stream(near).p2p().build(),
            Builder::async_io_unix_stream(far)
                .server(zbus::Guid::generate())
                .unwrap()
                .p2p()
                .serve_at("/bar", Accessible(advertised))
                .unwrap()
                .serve_at("/bar", Value(reads.clone()))
                .unwrap()
                .build(),
        ));
        let _server = server.unwrap();
        let bus = crate::system::bus::tests::connected(client.unwrap());
        let node = crate::tree::AtspiElement::new("org.agentdesktop.ScrollFixture", "/bar", 1);
        let handle = node.clone().into_native_handle();
        let mut port = BusPort::new(
            &bus,
            &handle,
            &node,
            agent_desktop_core::Deadline::after(5_000).unwrap(),
        );
        port.bar = Some(node.clone());
        let range = port.range().unwrap();
        assert_eq!(
            range.map(|range| (range.min, range.max, range.current)),
            advertised.then_some((0.0, 100.0, 50.0))
        );
        assert_eq!(reads.load(Ordering::SeqCst), if advertised { 3 } else { 0 });
    }
}

struct Pane;

#[zbus::interface(name = "org.a11y.atspi.Accessible")]
impl Pane {
    fn get_children(&self) -> Vec<(String, zbus::zvariant::OwnedObjectPath)> {
        ["/horizontal", "/vertical"]
            .into_iter()
            .map(|path| {
                (
                    "org.agentdesktop.ScrollFixture".into(),
                    path.try_into().unwrap(),
                )
            })
            .collect()
    }
}

struct Bar(u32);

#[zbus::interface(name = "org.a11y.atspi.Accessible")]
impl Bar {
    fn get_role(&self) -> u32 {
        crate::tree::vocabulary::role_numbers::SCROLL_BAR
    }

    fn get_state(&self) -> Vec<u32> {
        vec![1 << self.0, 0]
    }
}

#[test]
fn the_container_fast_path_never_uses_a_bar_to_reveal_another_bar() {
    use super::{Axis, BusPort};
    use crate::tree::{AtspiElement, element::ancestry::Ancestry};
    use zbus::connection::Builder;

    let (near, far) = std::os::unix::net::UnixStream::pair().unwrap();
    let (client, server) = zbus::block_on(futures_lite::future::zip(
        Builder::async_io_unix_stream(near).p2p().build(),
        Builder::async_io_unix_stream(far)
            .server(zbus::Guid::generate())
            .unwrap()
            .p2p()
            .serve_at("/pane", Pane)
            .unwrap()
            .serve_at("/horizontal", Bar(14))
            .unwrap()
            .serve_at("/vertical", Bar(29))
            .unwrap()
            .build(),
    ));
    let _server = server.unwrap();
    let bus = crate::system::bus::tests::connected(client.unwrap());
    let container = AtspiElement::new("org.agentdesktop.ScrollFixture", "/pane", 1);
    for path in ["/horizontal", "/vertical", "/content"] {
        let mut target = AtspiElement::new("org.agentdesktop.ScrollFixture", path, 1);
        target.set_ancestry(Ancestry::of(None, Some(container.clone()), false));
        let handle = target.clone().into_native_handle();
        let port = BusPort::new(
            &bus,
            &handle,
            &target,
            agent_desktop_core::Deadline::after(5_000).unwrap(),
        );
        assert_eq!(
            port.bar_in_container(Axis::Vertical)
                .unwrap()
                .map(|bar| bar.path().to_owned()),
            (path == "/content").then(|| "/vertical".to_owned())
        );
    }
}
#[test]
fn clipped_viewport_refuses_recovery_but_unknown_placement_does_not() {
    use super::super::scroll_plan::viewport_clipped;
    use crate::system::x11::window::window_x11_state::WindowX11State;
    use crate::tree::placement::Placement;
    let mut placed = Placement {
        container: Some(crate::tree::Extents {
            x: 0,
            y: 748,
            width: 600,
            height: 100,
        }),
        x11: Some(WindowX11State {
            client_id: 1,
            hidden: false,
            client_origin: (0, 0),
            shadow: (0, 0, 0, 0),
        }),
        displays: Some(vec![crate::tree::Extents {
            x: 0,
            y: 0,
            width: 1280,
            height: 800,
        }]),
        ..Placement::default()
    };
    assert!(viewport_clipped(&placed));
    placed.displays.as_mut().unwrap()[0].height = 1200;
    assert!(!viewport_clipped(&placed));
    placed.displays.as_mut().unwrap()[0].height = 800;
    placed.x11.as_mut().unwrap().client_origin.1 = -100;
    assert!(!viewport_clipped(&placed));
    placed.x11.as_mut().unwrap().shadow.1 = 100;
    assert!(viewport_clipped(&placed));
    placed.x11 = None;
    assert!(!viewport_clipped(&placed));
    assert!(!viewport_clipped(&Placement::default()));
}
