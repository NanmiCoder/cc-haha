use super::*;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Instant;

struct Daemon(Child, String);

impl Daemon {
    fn start(argument: &str) -> Self {
        let mut child = Command::new("dbus-daemon")
            .args(["--nofork", "--print-address=1", argument])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut address = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut address)
            .unwrap();
        Self(child, address.trim().to_owned())
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Address(Arc<Mutex<String>>);

#[zbus::interface(name = "org.a11y.Bus")]
impl Address {
    fn get_address(&self) -> String {
        self.0.lock().unwrap().clone()
    }
}

struct Registry;

#[zbus::interface(name = "org.a11y.atspi.Registry")]
impl Registry {
    fn register_event(&self, _event: &str, _properties: Vec<String>, _app: &str) {}
}

struct Empty;

#[zbus::interface(name = "org.a11y.atspi.Accessible")]
impl Empty {
    fn get_children(&self) -> Vec<(String, zbus::zvariant::OwnedObjectPath)> {
        Vec::new()
    }
}

fn registry(address: &str) -> AsyncConnection {
    zbus::block_on(async {
        Builder::address(address)
            .unwrap()
            .name(REGISTRY_SERVICE)
            .unwrap()
            .serve_at(REGISTRY_PATH, Registry)
            .unwrap()
            .serve_at(REGISTRY_ROOT_PATH, Empty)
            .unwrap()
            .build()
            .await
            .unwrap()
    })
}

fn await_file(path: &Path) {
    let until = Instant::now() + Duration::from_secs(10);
    while !path.exists() {
        assert!(Instant::now() < until, "fixture handshake: {path:?}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn lost_bus_never_activates_an_empty_replacement_registry() {
    const CHILD: &str = "AD_BUS_RECOVERY_CHILD";
    let deadline = || Deadline::after(5_000).unwrap();
    if let Some(directory) = std::env::var_os(CHILD) {
        let directory = PathBuf::from(directory);
        let bus = SharedBus::default();
        crate::system::context::inventory::query(
            &bus,
            agent_desktop_core::AppInventoryQuery::All,
            deadline(),
        )
        .unwrap();
        let guid = bus
            .get(deadline())
            .unwrap()
            .inner()
            .server_guid()
            .to_string();
        std::fs::write(directory.join("connected"), "").unwrap();
        await_file(&directory.join("stopped"));
        for _ in 0..3 {
            let error = crate::system::context::inventory::query(
                &bus,
                agent_desktop_core::AppInventoryQuery::Exact {
                    name: "still-running-app",
                    bundle_id: None,
                },
                deadline(),
            )
            .unwrap_err();
            assert_eq!(error.code, ErrorCode::Internal, "{error:?}");
        }
        std::fs::write(directory.join("loss-observed"), "").unwrap();
        await_file(&directory.join("restored"));
        crate::system::context::inventory::query(
            &bus,
            agent_desktop_core::AppInventoryQuery::All,
            deadline(),
        )
        .unwrap();
        assert_ne!(
            bus.get(deadline()).unwrap().inner().server_guid().as_str(),
            guid
        );
        return;
    }
    let directory =
        Scratch(std::env::temp_dir().join(format!("ad-bus-recovery-{}", std::process::id())));
    std::fs::create_dir_all(directory.0.join("services")).unwrap();
    let marker = directory.0.join("activation");
    std::fs::write(
        directory.0.join("services/org.a11y.Bus.service"),
        format!(
            "[D-BUS Service]\nName=org.a11y.Bus\nExec=/bin/sh -c 'touch {}; exit 1'\n",
            marker.display()
        ),
    )
    .unwrap();
    let config = directory.0.join("bus.conf");
    std::fs::write(&config, format!(
        "<!DOCTYPE busconfig PUBLIC \"-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN\" \"http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd\"><busconfig><type>session</type><listen>unix:tmpdir={}</listen><servicedir>{}/services</servicedir><policy context=\"default\"><allow send_destination=\"*\"/><allow receive_sender=\"*\"/><allow own=\"*\"/><allow user=\"*\"/></policy></busconfig>", directory.0.display(), directory.0.display()
    )).unwrap();
    let daemon_config = format!("--config-file={}", config.display());
    let session = Daemon::start(&daemon_config);
    let mut accessibility = Daemon::start(&daemon_config);
    let server = registry(&accessibility.1);
    let address = Arc::new(Mutex::new(accessibility.1.clone()));
    let launcher = zbus::block_on(async {
        Builder::address(session.1.as_str())
            .unwrap()
            .name(BUS_SERVICE)
            .unwrap()
            .serve_at(BUS_PATH, Address(address.clone()))
            .unwrap()
            .build()
            .await
            .unwrap()
    });
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "system::bus::recovery_tests::lost_bus_never_activates_an_empty_replacement_registry",
            "--nocapture",
        ])
        .env(CHILD, &directory.0)
        .env("DBUS_SESSION_BUS_ADDRESS", &session.1)
        .env_remove("AT_SPI_BUS_ADDRESS")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    await_file(&directory.0.join("connected"));
    zbus::block_on(launcher.release_name(BUS_SERVICE)).unwrap();
    accessibility.0.kill().unwrap();
    accessibility.0.wait().unwrap();
    std::fs::write(directory.0.join("stopped"), "").unwrap();
    let until = Instant::now() + Duration::from_secs(10);
    while !directory.0.join("loss-observed").exists() {
        if child.try_wait().unwrap().is_some() || Instant::now() >= until {
            let output = child.wait_with_output().unwrap();
            panic!("loss child: {}", String::from_utf8_lossy(&output.stderr));
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        !marker.exists(),
        "a lost bus must not activate an empty replacement"
    );
    let replacement = Daemon::start(&daemon_config);
    let _replacement_server = registry(&replacement.1);
    *address.lock().unwrap() = replacement.1.clone();
    zbus::block_on(launcher.request_name(BUS_SERVICE)).unwrap();
    std::fs::write(directory.0.join("restored"), "").unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    drop(server);
}
