use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use zbus::blocking::Connection;
use zbus::zvariant::OwnedObjectPath;

use super::wayland_portal_live_process::{Group, spawn};

pub(super) const ATTEMPTS: u32 = 8;
pub(super) const SOCKET_WAIT: Duration = Duration::from_secs(25);
pub(super) const SEAT_WAIT: Duration = Duration::from_secs(8);
pub(super) const RD: &str = "org.gnome.Mutter.RemoteDesktop";
pub(super) const RD_PATH: &str = "/org/gnome/Mutter/RemoteDesktop";
pub(super) const RD_SESSION: &str = "org.gnome.Mutter.RemoteDesktop.Session";
pub(super) const DIALOG_SHOWN: Duration = Duration::from_millis(4_500);
pub(super) const KEY_ESCAPE: u32 = 0xff1b;
pub(super) const KEY_TAB: u32 = 0xff09;
pub(super) const KEY_RETURN: u32 = 0xff0d;
pub(super) const KEY_SHIFT: u32 = 0xffe1;
pub(super) const BLUE: [u8; 3] = [0, 0, 255];

pub(super) const PAINTER: &str = r#"
import gi
gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, Gtk
window = Gtk.Window(title="adwl-paint")
window.set_default_size(400, 300)
css = Gtk.CssProvider()
css.load_from_data(b"window, window.background { background-color: #0000ff; background-image: none; }")
Gtk.StyleContext.add_provider_for_screen(Gdk.Screen.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_USER)
window.show_all()
Gtk.main()
"#;

pub(super) fn runtime_dir() -> PathBuf {
    PathBuf::from(std::env::var("XDG_RUNTIME_DIR").expect("a private runtime dir"))
}

pub(super) fn sockets() -> BTreeSet<String> {
    std::fs::read_dir(runtime_dir())
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|entry| entry.file_name().into_string().ok())
                .filter(|name| name.starts_with("wayland-") && !name.ends_with(".lock"))
                .collect()
        })
        .unwrap_or_default()
}

pub(super) struct Shell {
    _group: Group,
    socket: String,
}

pub(super) fn spawn_shell(monitors: &[&str]) -> Option<Shell> {
    for name in sockets() {
        let _ = std::fs::remove_file(runtime_dir().join(&name));
        let _ = std::fs::remove_file(runtime_dir().join(format!("{name}.lock")));
    }
    let before = sockets();
    let mut args = vec!["--headless", "--wayland"];
    for monitor in monitors {
        args.extend(["--virtual-monitor", monitor]);
    }
    let group = spawn("gnome-shell", &args, &[], "shell.log")?;
    let until = Instant::now() + SOCKET_WAIT;
    while Instant::now() < until {
        if let Some(socket) = sockets().difference(&before).next() {
            std::thread::sleep(Duration::from_secs(3));
            return Some(Shell {
                _group: group,
                socket: socket.clone(),
            });
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    None
}

pub(super) struct Keys {
    connection: Connection,
    session: String,
}

impl Keys {
    fn call<B: zbus::export::serde::Serialize + zbus::zvariant::DynamicType>(
        &self,
        member: &str,
        body: &B,
    ) -> Result<(), String> {
        self.connection
            .call_method(
                Some(RD),
                self.session.as_str(),
                Some(RD_SESSION),
                member,
                body,
            )
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    pub(super) fn press(&self, symbol: u32) {
        for down in [true, false] {
            self.call("NotifyKeyboardKeysym", &(symbol, down))
                .expect("a key reaches the shell");
        }
    }
}

pub(super) fn open_keys() -> Result<Keys, String> {
    let connection = Connection::session().map_err(|error| error.to_string())?;
    let reply = connection
        .call_method(Some(RD), RD_PATH, Some(RD), "CreateSession", &())
        .map_err(|error| error.to_string())?;
    let session = reply
        .body()
        .deserialize::<OwnedObjectPath>()
        .map_err(|error| error.to_string())?;
    let keys = Keys {
        connection,
        session: session.to_string(),
    };
    keys.call("Start", &())?;
    for down in [true, false] {
        keys.call("NotifyKeyboardKeysym", &(KEY_SHIFT, down))?;
    }
    keys.call("NotifyPointerMotionRelative", &(300.0_f64, 300.0_f64))?;
    std::thread::sleep(Duration::from_secs(1));
    Ok(keys)
}

pub(super) fn bounded_keys() -> Option<Keys> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(open_keys());
    });
    receiver.recv_timeout(SEAT_WAIT).ok()?.ok()
}

pub(super) struct Endpoint {
    pub(super) destination: &'static str,
    pub(super) path: &'static str,
    pub(super) interface: &'static str,
}

pub(super) const BUS_DAEMON: Endpoint = Endpoint {
    destination: "org.freedesktop.DBus",
    path: "/org/freedesktop/DBus",
    interface: "org.freedesktop.DBus",
};

pub(super) const PERMISSION_STORE: Endpoint = Endpoint {
    destination: "org.freedesktop.impl.portal.PermissionStore",
    path: "/org/freedesktop/impl/portal/PermissionStore",
    interface: "org.freedesktop.impl.portal.PermissionStore",
};

pub(super) fn bus_call<B: zbus::export::serde::Serialize + zbus::zvariant::DynamicType>(
    connection: &Connection,
    endpoint: &Endpoint,
    member: &str,
    body: &B,
) -> Option<zbus::Message> {
    connection
        .call_method(
            Some(endpoint.destination),
            endpoint.path,
            Some(endpoint.interface),
            member,
            body,
        )
        .ok()
}

pub(super) fn owner_pid(connection: &Connection, name: &str) -> Option<u32> {
    bus_call(
        connection,
        &BUS_DAEMON,
        "GetConnectionUnixProcessID",
        &(name,),
    )?
    .body()
    .deserialize::<u32>()
    .ok()
}

pub(super) fn owned(connection: &Connection, name: &str) -> bool {
    bus_call(connection, &BUS_DAEMON, "NameHasOwner", &(name,))
        .and_then(|reply| reply.body().deserialize::<bool>().ok())
        .unwrap_or(false)
}

pub(super) fn wait_owned(connection: &Connection, name: &str) -> bool {
    let until = Instant::now() + Duration::from_secs(30);
    while Instant::now() < until {
        if owned(connection, name) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    false
}

pub(super) const BACKEND: &str = "org.freedesktop.impl.portal.desktop.gnome";
pub(super) const FRONTEND: &str = "org.freedesktop.portal.Desktop";

pub(super) fn start_portal(socket: &str) -> Option<(Group, Group)> {
    let connection = Connection::session().ok()?;
    for name in [FRONTEND, BACKEND, "org.freedesktop.impl.portal.desktop.gtk"] {
        if let Some(pid) = owner_pid(&connection, name)
            && let Some(pid) = rustix::process::Pid::from_raw(i32::try_from(pid).ok()?)
        {
            let _ = rustix::process::kill_process(pid, rustix::process::Signal::KILL);
        }
    }
    std::thread::sleep(Duration::from_secs(1));
    let activation: HashMap<&str, &str> =
        HashMap::from([("WAYLAND_DISPLAY", socket), ("GDK_BACKEND", "wayland")]);
    bus_call(
        &connection,
        &BUS_DAEMON,
        "UpdateActivationEnvironment",
        &(activation,),
    )?;
    let env = [
        ("WAYLAND_DISPLAY", socket),
        ("GDK_BACKEND", "wayland"),
        ("XDG_SESSION_TYPE", "wayland"),
    ];
    let backend = spawn(
        "/usr/libexec/xdg-desktop-portal-gnome",
        &[],
        &env,
        "portal-gnome.log",
    )?;
    wait_owned(&connection, BACKEND).then_some(())?;
    let frontend = spawn(
        "/usr/libexec/xdg-desktop-portal",
        &["-r"],
        &env,
        "portal.log",
    )?;
    wait_owned(&connection, FRONTEND).then_some(())?;
    std::thread::sleep(Duration::from_secs(2));
    Some((backend, frontend))
}

pub(super) struct World {
    _shell: Shell,
    _portal: (Group, Group),
    _painter: Group,
    pub(super) keys: Keys,
}

/// The shell and the portal push a wayland-only environment into the bus's
/// activation set, where it outlives them: a later D-Bus-activated app
/// inherits the dead socket and a forced backend and dies at display init.
/// Hand the session's X11 display back so the session launches cleanly.
fn restore_activation_display() {
    let Ok(connection) = Connection::session() else {
        return;
    };
    let display = std::env::var("DISPLAY").unwrap_or_default();
    let activation: HashMap<&str, &str> = HashMap::from([
        ("DISPLAY", display.as_str()),
        ("WAYLAND_DISPLAY", ""),
        ("GDK_BACKEND", "x11"),
    ]);
    let _ = bus_call(
        &connection,
        &BUS_DAEMON,
        "UpdateActivationEnvironment",
        &(activation,),
    );
}

impl Drop for World {
    fn drop(&mut self) {
        restore_activation_display();
    }
}

pub(super) fn forget_screenshot_permission() {
    if let Ok(connection) = Connection::session() {
        let _ = bus_call(
            &connection,
            &PERMISSION_STORE,
            "Delete",
            &("screenshot", "screenshot"),
        );
    }
}

pub(super) fn boot() -> World {
    boot_with(&["1280x800"])
}

pub(super) fn boot_with(monitors: &[&str]) -> World {
    assert!(
        std::env::var_os("AGENT_DESKTOP_PRIVATE_SESSION").is_some(),
        "run inside scripts/private-session.sh"
    );
    assert!(std::env::var_os("WAYLAND_DISPLAY").is_none());
    for _ in 0..ATTEMPTS {
        let Some(shell) = spawn_shell(monitors) else {
            continue;
        };
        let Some(keys) = bounded_keys() else { continue };
        let Some(portal) = start_portal(&shell.socket) else {
            continue;
        };
        let painter = spawn(
            "python3",
            &["-c", PAINTER],
            &[
                ("GDK_BACKEND", "wayland"),
                ("WAYLAND_DISPLAY", &shell.socket),
            ],
            "painter.log",
        )
        .expect("the painter starts");
        forget_screenshot_permission();
        keys.press(KEY_ESCAPE);
        std::thread::sleep(Duration::from_millis(1_500));
        keys.press(KEY_ESCAPE);
        std::thread::sleep(Duration::from_secs(3));
        return World {
            _shell: shell,
            _portal: portal,
            _painter: painter,
            keys,
        };
    }
    panic!("no healthy headless gnome-shell with its portal after {ATTEMPTS} starts");
}

pub(super) fn stored_screenshot_grants() -> String {
    let Ok(connection) = Connection::session() else {
        return "no bus".into();
    };
    let listed = bus_call(&connection, &PERMISSION_STORE, "List", &("screenshot",))
        .and_then(|reply| reply.body().deserialize::<Vec<String>>().ok());
    let Some(ids) = listed else {
        return "no table".into();
    };
    let mut out = Vec::new();
    for id in ids {
        let looked = bus_call(
            &connection,
            &PERMISSION_STORE,
            "Lookup",
            &("screenshot", id.as_str()),
        )
        .and_then(|reply| {
            reply
                .body()
                .deserialize::<(HashMap<String, Vec<String>>, zbus::zvariant::OwnedValue)>()
                .ok()
        });
        out.push(format!("{id}={:?}", looked.map(|(grants, _)| grants)));
    }
    out.join(";")
}
