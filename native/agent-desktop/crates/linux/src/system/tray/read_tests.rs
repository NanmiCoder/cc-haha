use std::collections::HashMap;
use std::os::unix::net::UnixStream;

use agent_desktop_core::Deadline;
use zbus::connection::Builder;
use zbus::zvariant::{OwnedObjectPath, OwnedValue};

use super::TrayTarget;

struct Item(&'static str);

#[zbus::interface(name = "org.kde.StatusNotifierItem")]
impl Item {
    #[zbus(property)]
    fn title(&self) -> &str {
        "通知"
    }

    #[zbus(property)]
    fn status(&self) -> &str {
        self.0
    }

    #[zbus(property)]
    fn menu(&self) -> OwnedObjectPath {
        "/Menu".try_into().unwrap()
    }

    fn activate(&self, _x: i32, _y: i32) {}
}

struct Menu(bool);

type LayoutReply = (u32, (i32, HashMap<String, OwnedValue>, Vec<OwnedValue>));

#[zbus::interface(name = "com.canonical.dbusmenu")]
impl Menu {
    fn get_layout(
        &self,
        _parent: i32,
        _depth: i32,
        _properties: Vec<String>,
    ) -> zbus::fdo::Result<LayoutReply> {
        if self.0 {
            Err(zbus::fdo::Error::Failed("layout read refused".into()))
        } else {
            Ok((1, (0, HashMap::new(), Vec::new())))
        }
    }
}

#[test]
fn unreadable_tray_menu_is_not_a_complete_empty_menu() {
    for refuse in [false, true] {
        let (client, _server) = connection("Active", refuse);
        let target = TrayTarget {
            owner: ":1.20".into(),
            object_path: "/Item".into(),
            menu_path: None,
            entry_id: None,
            label_path: Vec::new(),
        };
        let result = super::describe(&client, target, Deadline::after(2_000).unwrap());
        if refuse {
            let error = result.err().expect("failed layout cannot become no menu");
            assert!(
                error
                    .platform_detail
                    .unwrap()
                    .contains("layout read refused")
            );
        } else {
            let item = result.expect("an independently served empty menu is readable");
            assert_eq!(item.evidence.title, "通知");
            assert!(
                item.evidence
                    .methods
                    .iter()
                    .any(|method| method == "Activate")
            );
            assert!(item.layout.unwrap().root.children.is_empty());
        }
    }
}

fn connection(status: &'static str, refuse: bool) -> (zbus::Connection, zbus::Connection) {
    let (client, server) = UnixStream::pair().unwrap();
    let (client, server) = zbus::block_on(futures_lite::future::zip(
        Builder::async_io_unix_stream(client).p2p().build(),
        Builder::async_io_unix_stream(server)
            .server(zbus::Guid::generate())
            .unwrap()
            .p2p()
            .serve_at("/Item", Item(status))
            .unwrap()
            .serve_at("/Menu", Menu(refuse))
            .unwrap()
            .build(),
    ));
    (client.unwrap(), server.unwrap())
}

#[test]
fn unknown_tray_status_cannot_authorize_semantic_delivery() {
    for status in ["Active", "Passive", "NeedsAttention", "", "unreadable"] {
        let (client, _server) = connection(status, false);
        let target = TrayTarget {
            owner: ":1.20".into(),
            object_path: "/Item".into(),
            menu_path: None,
            entry_id: None,
            label_path: Vec::new(),
        };
        let read = super::super::item::read(&client, &target, Deadline::after(2_000).unwrap());
        if matches!(status, "Active" | "Passive" | "NeedsAttention") {
            assert_eq!(read.unwrap().passive, status == "Passive");
        } else {
            let error = read.expect_err("unknown Status must not become visible");
            assert_eq!(error.code, agent_desktop_core::ErrorCode::AppUnresponsive);
            assert_eq!(
                error.disposition,
                agent_desktop_core::DeliverySemantics::not_delivered()
            );
        }
    }
}
