use zbus::connection::Builder;
use zbus::zvariant::OwnedObjectPath;

use super::focused;
use crate::tree::AtspiElement;
use crate::tree::vocabulary::state_bits::{EDITABLE, FOCUSED};

const OWNER: &str = "org.agentdesktop.FocusFixture";

#[test]
fn expired_focus_reads_and_grabs_preserve_the_deadline_error() {
    use agent_desktop_core::{Deadline, ErrorCode};
    let bus = crate::system::SharedBus::default();
    let element = AtspiElement::new(OWNER, "/entry", 1);
    let deadline = Deadline::detached_after(0).unwrap();
    for error in [
        super::read(&bus, &element, deadline).unwrap_err(),
        super::grab(&bus, &element, deadline).unwrap_err(),
    ] {
        assert_eq!(error.code, ErrorCode::Timeout);
        assert!(error.details.is_some(), "deadline metadata survives");
    }
}

struct Accessible {
    states: Option<u32>,
    interfaces: Vec<&'static str>,
    parent: &'static str,
}

#[zbus::interface(name = "org.a11y.atspi.Accessible")]
impl Accessible {
    fn get_state(&self) -> Result<Vec<u32>, zbus::fdo::Error> {
        self.states
            .map(|states| vec![states, 0])
            .ok_or_else(|| zbus::fdo::Error::TimedOut("fixture state timeout".into()))
    }

    fn get_interfaces(&self) -> Vec<&str> {
        self.interfaces.clone()
    }

    #[zbus(property)]
    fn parent(&self) -> (String, OwnedObjectPath) {
        (
            OWNER.to_owned(),
            self.parent.try_into().expect("parent path"),
        )
    }
}

struct Component {
    hit: &'static str,
    owner: &'static str,
    reads: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

#[zbus::interface(name = "org.a11y.atspi.Component")]
impl Component {
    fn get_extents(&self, _coordinates: u32) -> (i32, i32, i32, i32) {
        self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        (9, 0, 355, 34)
    }

    fn get_accessible_at_point(
        &self,
        _x: i32,
        _y: i32,
        _coordinates: u32,
    ) -> (String, OwnedObjectPath) {
        self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        (
            self.owner.to_owned(),
            self.hit.try_into().expect("hit path"),
        )
    }
}

#[test]
fn focused_internal_editor_is_proven_only_under_its_entry() {
    for component in [true, false] {
        for (entry_focused, editor_focused, editable, parent, hit_owner, hit, expected) in [
            (false, true, true, "/entry", OWNER, "/placeholder", true),
            (false, true, true, "/entry", OWNER, "/editor", true),
            (false, false, true, "/entry", OWNER, "/placeholder", false),
            (false, true, true, "/other", OWNER, "/placeholder", false),
            (false, true, false, "/entry", OWNER, "/editor", false),
            (
                false,
                true,
                true,
                "/entry",
                "org.agentdesktop.Other",
                "/editor",
                false,
            ),
            (false, true, true, "/entry", OWNER, "/missing", false),
            (true, false, false, "/entry", OWNER, "/missing", true),
        ] {
            let reads = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let (near, far) = std::os::unix::net::UnixStream::pair().expect("socket pair");
            let (client, server) = zbus::block_on(async {
                futures_lite::future::zip(
                    Builder::async_io_unix_stream(near).p2p().build(),
                    Builder::async_io_unix_stream(far)
                        .server(zbus::Guid::generate())
                        .expect("guid")
                        .p2p()
                        .serve_at(
                            "/entry",
                            Accessible {
                                states: Some(
                                    (1 << EDITABLE) | if entry_focused { 1 << FOCUSED } else { 0 },
                                ),
                                interfaces: if component {
                                    vec!["org.a11y.atspi.Component"]
                                } else {
                                    vec![]
                                },
                                parent: "/frame",
                            },
                        )
                        .expect("entry")
                        .serve_at(
                            "/entry",
                            Component {
                                hit,
                                owner: hit_owner,
                                reads: reads.clone(),
                            },
                        )
                        .expect("component")
                        .serve_at(
                            "/placeholder",
                            Accessible {
                                states: Some(0),
                                interfaces: vec!["org.a11y.atspi.Text"],
                                parent: "/editor",
                            },
                        )
                        .expect("placeholder")
                        .serve_at(
                            "/editor",
                            Accessible {
                                states: Some(if editor_focused { 1 << FOCUSED } else { 0 }),
                                interfaces: if editable {
                                    vec!["org.a11y.atspi.Text", "org.a11y.atspi.EditableText"]
                                } else {
                                    vec!["org.a11y.atspi.Text"]
                                },
                                parent,
                            },
                        )
                        .expect("editor")
                        .build(),
                )
                .await
            });
            let _server = server.expect("server");
            let client = client.expect("client");
            let entry = AtspiElement::new(OWNER, "/entry", 1);
            let actual = zbus::block_on(focused(&client, &entry))
                .expect("a readable entry retains the ordinary focus-acquisition path");
            assert_eq!(
                actual,
                expected && (entry_focused || component),
                "entry_focused={entry_focused}, editor_focused={editor_focused}, editable={editable}, parent={parent}, owner={hit_owner}"
            );
            if !component {
                assert_eq!(
                    reads.load(std::sync::atomic::Ordering::SeqCst),
                    0,
                    "unadvertised Component must receive no reads"
                );
            }
        }
    }
}

#[test]
fn focus_state_bus_timeouts_keep_the_platform_cause() {
    let (near, far) = std::os::unix::net::UnixStream::pair().unwrap();
    let (client, server) = zbus::block_on(async {
        futures_lite::future::zip(
            Builder::async_io_unix_stream(near).p2p().build(),
            Builder::async_io_unix_stream(far)
                .server(zbus::Guid::generate())
                .unwrap()
                .p2p()
                .serve_at(
                    "/entry",
                    Accessible {
                        states: None,
                        interfaces: vec![],
                        parent: "/frame",
                    },
                )
                .unwrap()
                .build(),
        )
        .await
    });
    let _server = server.unwrap();
    let client = client.unwrap();
    let error =
        zbus::block_on(focused(&client, &AtspiElement::new(OWNER, "/entry", 1))).unwrap_err();
    assert_eq!(error.code, agent_desktop_core::ErrorCode::Timeout);
    assert!(
        error
            .platform_detail
            .unwrap()
            .contains("fixture state timeout")
    );
}
