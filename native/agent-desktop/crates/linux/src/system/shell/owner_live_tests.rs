use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use agent_desktop_core::{Deadline, ErrorCode};
use zbus::blocking::Connection;
use zbus::zvariant::OwnedObjectPath;

use super::identity::{find_root, is_shell_owner};
use crate::system::SharedBus;
use crate::tree::vocabulary::role_numbers::{LABEL, PUSH_BUTTON, TOGGLE_BUTTON};

const APP: &str = r#"
import ctypes,os,sys,gi,signal
gi.require_version('Gtk','3.0')
from gi.repository import Gtk,Gio,GLib
bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
owned=False
if sys.argv[1]=='owner':
    result=bus.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','RequestName',GLib.Variant('(su)',('org.gnome.Shell',4)),None,Gio.DBusCallFlags.NONE,3000,None)
    owned=result.unpack()[0]==1
if owned or sys.argv[1]=='notification':
    bus.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','RequestName',GLib.Variant('(su)',('org.freedesktop.Notifications',4)),None,Gio.DBusCallFlags.NONE,3000,None)
    info=Gio.DBusNodeInfo.new_for_xml('<node><interface name="org.freedesktop.Notifications"><method name="GetServerInformation"><arg type="s" direction="out"/><arg type="s" direction="out"/><arg type="s" direction="out"/><arg type="s" direction="out"/></method></interface></node>')
    def method(_connection,_sender,_path,_interface,_method,_args,invocation):
        invocation.return_value(GLib.Variant('(ssss)',('通知実装' if owned else 'gnome-shell','fixture','1','1.2')))
    bus.register_object('/org/freedesktop/Notifications',info.interfaces[0],method,None,None)
def release(*_):
    bus.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','ReleaseName',GLib.Variant('(s)',('org.freedesktop.Notifications',)),None,Gio.DBusCallFlags.NONE,3000,None)
signal.signal(signal.SIGUSR1,release)
ctypes.CDLL(None).prctl(15,b'renamed-shell' if owned else b'gnome-shell',0,0,0)
window=Gtk.Window(title='構造')
history=Gtk.Box()
footer=Gtk.Box()
footer.add(Gtk.Label(label='通知'))
footer.add(Gtk.ToggleButton(label='停止'))
footer.add(Gtk.Button(label='消去'))
history.add(footer)
window.add(history)
window.show_all()
print(os.getpid(),int(owned),flush=True)
GLib.timeout_add(50,lambda: True)
Gtk.main()
"#;

struct App(Child);

impl Drop for App {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn spawn(mode: &str) -> (App, u32, bool) {
    let mut child = Command::new("python3")
        .args(["-c", APP, mode])
        .stdout(Stdio::piped())
        .spawn()
        .expect("real GTK app");
    let mut ready = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut ready)
        .unwrap();
    let fields: Vec<_> = ready.split_whitespace().collect();
    let pid = fields[0].parse().unwrap();
    (App(child), pid, fields[1] == "1")
}

fn accessibility() -> Connection {
    let session = Connection::session().unwrap();
    let address: String = session
        .call_method(
            Some("org.a11y.Bus"),
            "/org/a11y/bus",
            Some("org.a11y.Bus"),
            "GetAddress",
            &(),
        )
        .unwrap()
        .body()
        .deserialize()
        .unwrap();
    zbus::blocking::connection::Builder::address(address.as_str())
        .unwrap()
        .method_timeout(Duration::from_secs(2))
        .build()
        .unwrap()
}

fn children(connection: &Connection, name: &str, path: &str) -> Vec<(String, OwnedObjectPath)> {
    connection
        .call_method(
            Some(name),
            path,
            Some("org.a11y.atspi.Accessible"),
            "GetChildren",
            &(),
        )
        .unwrap()
        .body()
        .deserialize()
        .unwrap()
}

fn role(connection: &Connection, name: &str, path: &str) -> u32 {
    connection
        .call_method(
            Some(name),
            path,
            Some("org.a11y.atspi.Accessible"),
            "GetRole",
            &(),
        )
        .unwrap()
        .body()
        .deserialize()
        .unwrap()
}

fn window(connection: &Connection, pid: u32) -> (String, String) {
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        let registry = children(
            connection,
            "org.a11y.atspi.Registry",
            "/org/a11y/atspi/accessible/root",
        );
        for (name, path) in registry {
            let owner: u32 = connection
                .call_method(
                    Some("org.freedesktop.DBus"),
                    "/org/freedesktop/DBus",
                    Some("org.freedesktop.DBus"),
                    "GetConnectionUnixProcessID",
                    &(name.as_str(),),
                )
                .unwrap()
                .body()
                .deserialize()
                .unwrap();
            if owner != pid {
                continue;
            }
            for (name, path) in children(connection, &name, path.as_str()) {
                if matches!(role(connection, &name, path.as_str()), 23 | 69) {
                    return (name, path.to_string());
                }
            }
        }
        assert!(
            Instant::now() < until,
            "independent AT-SPI window readiness"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
#[ignore = "real GTK service owner and name-spoof control; private session only"]
pub(super) fn shell_identity_follows_both_bus_owners_and_never_the_process_name() {
    assert!(std::env::var_os("AGENT_DESKTOP_PRIVATE_SESSION").is_some());
    let connection = accessibility();
    let (_owner, pid, owned) = spawn("owner");
    assert!(
        owned,
        "the private session must leave org.gnome.Shell unowned for the owner fixture"
    );
    let (name, path) = window(&connection, pid);
    assert_eq!(
        std::fs::read_to_string(format!("/proc/{pid}/comm"))
            .unwrap()
            .trim(),
        "renamed-shell"
    );
    let root = find_root(&SharedBus::default(), Deadline::after(5_000).unwrap())
        .expect("session service owner works with any process name");
    assert_eq!(
        (root.bus_name.as_str(), root.path.as_str(), root.pid),
        (name.as_str(), path.as_str(), pid)
    );
    assert!(is_shell_owner(&name, pid));
    assert!(!is_shell_owner(&name, u32::MAX));
    let located = super::container::locate_anchor(
        &SharedBus::default(),
        &root,
        super::anchor::Anchor::Landmark(super::container::Landmark::MessageList),
        Deadline::after(5_000).unwrap(),
    )
    .expect("a footer row of real toolkit controls proves the list without text or geometry");
    let container = &located.container.element;
    let rows = children(&connection, container.bus_name(), container.path());
    assert_eq!(rows.len(), 1);
    let footer: Vec<u32> = children(&connection, &rows[0].0, rows[0].1.as_str())
        .iter()
        .map(|(name, path)| role(&connection, name, path.as_str()))
        .collect();
    assert_eq!(footer, [LABEL, TOGGLE_BUTTON, PUSH_BUTTON]);
    super::detect::require_daemon(Deadline::after(5_000).unwrap())
        .expect("notification capability comes from matching owners, not branding");
    agent_desktop_core::SystemOps::check_notification_support(
        &crate::LinuxAdapter::new(),
        Deadline::after(5_000).unwrap(),
    )
    .expect("the adapter's support check follows the same owners");
    let session = Connection::session().unwrap();
    let information: (String, String, String, String) = session
        .call_method(
            Some("org.freedesktop.Notifications"),
            "/org/freedesktop/Notifications",
            Some("org.freedesktop.Notifications"),
            "GetServerInformation",
            &(),
        )
        .unwrap()
        .body()
        .deserialize()
        .unwrap();
    assert_eq!(information.0, "通知実装");
    assert!(
        Command::new("kill")
            .args(["-USR1", &pid.to_string()])
            .status()
            .unwrap()
            .success()
    );
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        let present: bool = session
            .call_method(
                Some("org.freedesktop.DBus"),
                "/org/freedesktop/DBus",
                Some("org.freedesktop.DBus"),
                "NameHasOwner",
                &("org.freedesktop.Notifications",),
            )
            .unwrap()
            .body()
            .deserialize()
            .unwrap();
        if !present {
            break;
        }
        assert!(
            Instant::now() < until,
            "owned notification endpoint release"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let (_foreign, _, _) = spawn("notification");
    let error = super::detect::require_daemon(Deadline::after(5_000).unwrap())
        .expect_err("branding cannot authorize a different notification owner");
    assert_eq!(error.code, ErrorCode::PlatformNotSupported);
    assert_eq!(error.details.unwrap()["daemon"], "unsupported");
    let (_control, pid, _) = spawn("ordinary");
    let (name, _) = window(&connection, pid);
    assert_eq!(
        std::fs::read_to_string(format!("/proc/{pid}/comm"))
            .unwrap()
            .trim(),
        "gnome-shell"
    );
    assert!(
        !is_shell_owner(&name, pid),
        "a process name cannot impersonate the shell"
    );
    println!(
        "independent bus owner and native GTK window: owner={owned}; renamed owner accepted, same-name control refused"
    );
}
