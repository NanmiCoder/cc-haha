use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use agent_desktop_core::{DeliverySemantics, WindowFilter};

use super::*;
use crate::system::{app_inventory, list_windows};
use crate::tree::live::live_launch::Launched;

struct PrivateDaemon(Child);

impl Drop for PrivateDaemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct Listener;

#[zbus::interface(name = "org.a11y.atspi.Registry")]
impl Listener {
    fn register_event(&self, _event: &str, _properties: Vec<String>, _app: &str) {}
}

struct EmptyRegistry {
    refuse: std::sync::Arc<std::sync::atomic::AtomicBool>,
    wait: std::sync::Arc<Mutex<Option<futures_util::future::AbortRegistration>>>,
    entered: std::sync::mpsc::Sender<()>,
}

#[zbus::interface(name = "org.a11y.atspi.Accessible")]
impl EmptyRegistry {
    fn get_role(&self) -> u32 {
        75
    }

    async fn get_children(
        &self,
    ) -> zbus::fdo::Result<Vec<(String, zbus::zvariant::OwnedObjectPath)>> {
        let wait = self.wait.lock().expect("fixture gate").take();
        if let Some(wait) = wait {
            self.entered.send(()).expect("independent server receipt");
            let _ = futures_util::future::Abortable::new(std::future::pending::<()>(), wait).await;
        }
        if self.refuse.load(std::sync::atomic::Ordering::SeqCst) {
            Err(zbus::fdo::Error::Failed(
                "fixture method refusal".to_owned(),
            ))
        } else {
            Ok(Vec::new())
        }
    }
}

fn deadline() -> Deadline {
    Deadline::after(5_000).expect("deadline")
}

#[test]
#[ignore = "owns a private bus; run inside scripts/private-session.sh --wm"]
fn bus_live_loss_reconnects_without_treating_failed_reads_as_absence() {
    let runtime = std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").expect("private session");
    let socket = format!("{runtime}/loss-bus");
    let mut daemon = PrivateDaemon(
        Command::new("dbus-daemon")
            .args([
                "--session",
                "--nofork",
                "--print-address=1",
                &format!("--address=unix:path={socket}"),
            ])
            .stdout(Stdio::piped())
            .spawn()
            .expect("own daemon"),
    );
    let mut address = String::new();
    BufReader::new(daemon.0.stdout.take().expect("address pipe"))
        .read_line(&mut address)
        .expect("daemon readiness");
    let address = address.trim();
    let refuse = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let wait = std::sync::Arc::new(Mutex::new(None));
    let (entered, received) = std::sync::mpsc::channel();
    let server = zbus::block_on(async {
        Builder::address(address)
            .expect("address")
            .name(REGISTRY_SERVICE)
            .expect("name")
            .serve_at(
                REGISTRY_ROOT_PATH,
                EmptyRegistry {
                    refuse: refuse.clone(),
                    wait: wait.clone(),
                    entered,
                },
            )
            .expect("registry")
            .serve_at(REGISTRY_PATH, Listener)
            .expect("listener")
            .build()
            .await
            .expect("server")
    });
    let client =
        zbus::block_on(Builder::address(address).expect("address").build()).expect("connection");
    let bus = super::tests::connected(client);
    let connection = bus.get(deadline()).expect("cached connection");
    let root = crate::tree::AtspiElement::new(REGISTRY_SERVICE, REGISTRY_ROOT_PATH, 0);
    let read = within(
        deadline(),
        crate::tree::read_node(connection.inner(), &root),
    )
    .expect("unimplemented fields stay local while the object answers");
    assert_eq!(read.traits.role, crate::tree::Field::Present(75));
    let empty_nodes =
        crate::system::shell::light::LiveNodes::new(connection.inner().clone(), deadline());
    assert!(
        crate::system::shell::identity::content_window(&empty_nodes, &root)
            .expect("the independent registry serves an empty child list")
            .is_none(),
        "an empty app must never be substituted for its missing window"
    );
    refuse.store(true, std::sync::atomic::Ordering::SeqCst);
    let refused = app_inventory(&bus, deadline()).expect_err("a method refusal is not bus loss");
    assert_eq!(
        bus.cached()
            .expect("method refusal retains the connection")
            .inner()
            .unique_name(),
        connection.inner().unique_name(),
    );
    assert_eq!(refused.code, ErrorCode::Internal);
    assert!(
        refused
            .platform_detail
            .expect("method detail")
            .contains("fixture method refusal")
    );
    refuse.store(false, std::sync::atomic::Ordering::SeqCst);
    assert!(
        app_inventory(&bus, deadline())
            .expect("live registry")
            .apps
            .is_empty()
    );
    let (release, registration) = futures_util::future::AbortHandle::new_pair();
    *wait.lock().expect("fixture gate") = Some(registration);
    let stalled_nodes = crate::system::shell::light::LiveNodes::new(
        connection.inner().clone(),
        Deadline::after(1_000).expect("read deadline"),
    );
    let stalled = crate::system::shell::identity::content_window(&stalled_nodes, &root);
    release.abort();
    received
        .recv_timeout(Duration::from_secs(2))
        .expect("server confirms the request reached its wait gate");
    assert_eq!(
        stalled
            .expect_err("a server read deadline must not become a missing window")
            .code,
        ErrorCode::Timeout
    );
    daemon.0.kill().expect("kill only owned daemon");
    let exit = daemon.0.wait().expect("independent process exit oracle");
    assert!(!exit.success());
    let node_error = within(
        deadline(),
        crate::tree::read_node(connection.inner(), &root),
    )
    .expect_err("transport failure must not become a partial tree");
    assert_eq!(node_error.code, ErrorCode::Internal);
    let nodes = crate::system::shell::light::LiveNodes::new(connection.inner().clone(), deadline());
    let shell_error = crate::system::shell::identity::content_window(&nodes, &root)
        .expect_err("an unreadable shell is not a missing window");
    assert_eq!(shell_error.code, ErrorCode::Internal);
    let _replacement = SharedBus::default()
        .get(deadline())
        .expect("a new client starts the replacement accessibility service");
    for _ in 0..2 {
        app_inventory(&bus, deadline())
            .expect("the next inventory reconnects to the private session");
        let fresh = bus.get(deadline()).expect("recovered connection");
        assert_ne!(
            fresh.inner().server_guid(),
            connection.inner().server_guid(),
            "a failed transport cannot authorize an inventory"
        );
        probe_registry(&bus, &fresh, deadline()).expect("independent registry readback");
    }
    drop(server);
}

#[test]
#[ignore = "stops an owned app; run inside scripts/private-session.sh --wm"]
fn bus_live_stopped_app_is_unresponsive_while_the_bus_still_answers() {
    let bus = SharedBus::default();
    let mut launched = Launched::new();
    let pid = launched.spawn("gnome-calculator", &[]);
    let filter = WindowFilter {
        app: Some("gnome-calculator".to_owned()),
        ..WindowFilter::default()
    };
    let until = Instant::now() + Duration::from_secs(30);
    loop {
        if list_windows(&bus, &filter, deadline())
            .is_ok_and(|windows| windows.iter().any(|window| window.pid == pid))
        {
            break;
        }
        assert!(Instant::now() < until, "calculator window readiness");
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(
        Command::new("kill")
            .args(["-STOP", &pid.to_string()])
            .status()
            .expect("stop")
            .success()
    );
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        let status =
            std::fs::read_to_string(format!("/proc/{pid}/status")).expect("process oracle");
        if status
            .lines()
            .any(|line| line.starts_with("State:") && line.contains("T (stopped)"))
        {
            break;
        }
        assert!(Instant::now() < until, "SIGSTOP oracle");
        std::thread::yield_now();
    }
    let error = list_windows(&bus, &filter, deadline()).expect_err("stopped app");
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    let connection = bus.get(deadline()).expect("bus connection");
    probe_registry(&bus, &connection, deadline()).expect("registry still answers");
    println!("/proc confirms SIGSTOP: app = {error:?}; registry still answers");
}
