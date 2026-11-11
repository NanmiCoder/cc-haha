use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::{Builder, Deadline, ErrorCode, SharedBus};
use crate::system::registry::read_registry;

struct Registry;

struct Events;

#[zbus::interface(name = "org.a11y.atspi.Registry")]
impl Events {
    fn register_event(&self, _event: &str, _properties: Vec<String>, _app: &str) {}
}

#[zbus::interface(name = "org.a11y.atspi.Accessible")]
impl Registry {
    fn get_children(&self) -> Vec<(String, zbus::zvariant::OwnedObjectPath)> {
        vec![(
            ":1.23".to_owned(),
            "/org/a11y/atspi/accessible/root".try_into().expect("path"),
        )]
    }
}

struct Owners {
    socket: UnixStream,
    disconnect: bool,
    calls: Arc<AtomicUsize>,
}

#[zbus::interface(name = "org.freedesktop.DBus")]
impl Owners {
    fn get_name_owner(&self, _name: &str) -> String {
        ":1.registry".into()
    }

    #[zbus(name = "GetConnectionUnixProcessID")]
    fn process_id(&self, name: &str) -> zbus::fdo::Result<u32> {
        if name == ":1.registry" {
            return Ok(std::process::id());
        }
        assert_eq!(name, ":1.23");
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.disconnect {
            self.socket
                .shutdown(Shutdown::Both)
                .expect("disconnect peer");
            Err(zbus::fdo::Error::Failed("disconnected".to_owned()))
        } else {
            Err(zbus::fdo::Error::NameHasNoOwner("departed".to_owned()))
        }
    }
}

fn peer(disconnect: bool) -> (SharedBus, zbus::Connection, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let (client, server) = UnixStream::pair().expect("socket pair");
    let socket = server.try_clone().expect("shutdown handle");
    let (client, server) = zbus::block_on(async {
        futures_lite::future::zip(
            Builder::async_io_unix_stream(client).p2p().build(),
            Builder::async_io_unix_stream(server)
                .server(zbus::Guid::generate())
                .expect("server guid")
                .p2p()
                .serve_at(super::REGISTRY_PATH, Events)
                .expect("event registration")
                .serve_at(super::REGISTRY_ROOT_PATH, Registry)
                .expect("registry")
                .serve_at(
                    "/org/freedesktop/DBus",
                    Owners {
                        socket,
                        disconnect,
                        calls: calls.clone(),
                    },
                )
                .expect("owner lookup")
                .build(),
        )
        .await
    });
    let server = server.expect("server connection");
    let bus = super::tests::connected(client.expect("client connection"));
    (bus, server, calls)
}

#[test]
fn pid_lookup_bus_loss_is_not_a_complete_empty_inventory() {
    for disconnect in [true, false] {
        let (bus, _server, calls) = peer(disconnect);
        let result = read_registry(&bus, Deadline::after(5_000).expect("budget"));
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "PID lookup follows GetChildren"
        );
        if disconnect {
            let error = result
                .err()
                .expect("transport loss must reject the inventory");
            assert_eq!(error.code, ErrorCode::Internal);
            assert!(bus.cached().is_none(), "a later inventory must reconnect");
        } else {
            let registry = result.expect("confirmed departure is local");
            assert!(registry.apps.is_empty());
            assert_eq!(registry.skipped.len(), 1);
            assert!(
                bus.cached().is_some(),
                "departure keeps a healthy connection"
            );
        }
    }
}

#[test]
#[ignore = "observes an owned app across injected bus loss; run inside scripts/private-session.sh --wm"]
fn pid_lookup_live_bus_loss_never_closes_a_running_apps_windows() {
    use crate::system::focus::focus_window::lift_live_tests::{xid_of, xprop};
    use crate::system::signal::signal_capture::capture_signal_baseline;
    use crate::tree::live::live_launch::Launched;
    use agent_desktop_core::{ProcessIdentity, SignalFilter};

    for _ in 0..2 {
        let mut launched = Launched::new();
        let pid = launched.spawn("zenity", &["--info", "--text=still running"]);
        let xid = xid_of(pid);
        let instance = crate::system::process::process_facts::read(pid)
            .expect("running process")
            .instance;
        let filter = SignalFilter {
            process: Some(ProcessIdentity::new(pid, instance)),
            ..SignalFilter::default()
        };
        let healthy = SharedBus::default();
        let until = std::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            if capture_signal_baseline(&healthy, &filter, Deadline::after(5_000).expect("budget"))
                .is_ok_and(|baseline| {
                    baseline.completeness.apps
                        && baseline.apps.iter().any(|app| app.pid.get() == pid)
                })
            {
                break;
            }
            assert!(std::time::Instant::now() < until, "healthy app baseline");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let (bus, _server, calls) = peer(true);
        let error = capture_signal_baseline(&bus, &filter, Deadline::after(5_000).expect("budget"))
            .expect_err("PID transport failure cannot produce disappearance evidence");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(error.code, ErrorCode::Timeout);
        assert!(bus.cached().is_none());
        assert!(xprop(&["-id", &xid, "_NET_WM_PID"]).contains(&pid.to_string()));
        assert!(std::path::Path::new(&format!("/proc/{pid}/exe")).exists());
        let recovered =
            capture_signal_baseline(&healthy, &filter, Deadline::after(5_000).expect("budget"))
                .expect("live app remains in the healthy registry");
        assert!(recovered.apps.iter().any(|app| app.pid.get() == pid));
        println!(
            "xprop and /proc confirm owner {pid} lives; PID bus loss rejects signal baseline with TIMEOUT"
        );
    }
}
