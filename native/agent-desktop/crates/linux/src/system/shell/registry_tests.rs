use std::os::unix::net::UnixStream;

use agent_desktop_core::Deadline;
use zbus::connection::Builder;

struct Registry;

#[zbus::interface(name = "org.a11y.atspi.Accessible")]
impl Registry {
    fn get_children(&self) -> Vec<(String, zbus::zvariant::OwnedObjectPath)> {
        [":1.20", ":1.21"]
            .into_iter()
            .map(|name| (name.to_owned(), "/root".try_into().unwrap()))
            .collect()
    }
}

struct Owners(&'static str);

#[zbus::interface(name = "org.freedesktop.DBus")]
impl Owners {
    #[zbus(name = "GetConnectionUnixProcessID")]
    fn process_id(&self, name: &str) -> zbus::fdo::Result<u32> {
        if name == ":1.20" {
            return Ok(42);
        }
        match self.0 {
            "live" => Ok(43),
            "departed" => Err(zbus::fdo::Error::NameHasNoOwner("departed".into())),
            _ => Err(zbus::fdo::Error::AccessDenied("owner read refused".into())),
        }
    }
}

#[test]
fn shell_owner_inventory_never_hides_a_failed_owner_read() {
    for outcome in ["live", "departed", "refused"] {
        let (client, server) = UnixStream::pair().unwrap();
        let (client, server) = zbus::block_on(futures_lite::future::zip(
            Builder::async_io_unix_stream(client).p2p().build(),
            Builder::async_io_unix_stream(server)
                .server(zbus::Guid::generate())
                .unwrap()
                .p2p()
                .serve_at(crate::system::REGISTRY_ROOT_PATH, Registry)
                .unwrap()
                .serve_at("/org/freedesktop/DBus", Owners(outcome))
                .unwrap()
                .build(),
        ));
        let client = client.unwrap();
        let _server = server.unwrap();
        let result = crate::system::within(Deadline::after(2_000).unwrap(), super::read(&client));
        if outcome == "refused" {
            let error = result.expect_err("a partial registry cannot authorize shell identity");
            assert!(
                error
                    .platform_detail
                    .unwrap()
                    .contains("owner read refused")
            );
        } else {
            let apps = result.expect("only confirmed departures can be omitted");
            assert_eq!(apps.len(), if outcome == "live" { 2 } else { 1 });
            assert_eq!(apps[0].1, 42);
        }
    }
}
