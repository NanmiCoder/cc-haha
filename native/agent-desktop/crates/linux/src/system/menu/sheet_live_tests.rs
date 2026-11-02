use std::time::{Duration, Instant};

use agent_desktop_core::{Deadline, ProcessIdentity, SurfaceInfo, WindowFilter, WindowInfo};
use zbus::blocking::Connection;

use crate::system::{
    ACCESSIBLE_INTERFACE, PROPERTIES_INTERFACE, REGISTRY_ROOT_PATH, REGISTRY_SERVICE, SharedBus,
    app_inventory, list_surfaces, list_windows,
};
use crate::tree::live::live_launch::Launched;

const SETTLE: Duration = Duration::from_secs(40);
const ACTION_INTERFACE: &str = "org.a11y.atspi.Action";
const MENU_BUTTON: u32 = 43;
const TOGGLE: u32 = 62;
const MENU: u32 = 33;
const MENU_ITEM: u32 = 35;
const STATE_SHOWING: u32 = 25;
const NODE_LIMIT: usize = 4000;

struct Entry {
    bus: String,
    path: String,
    role: u32,
    name: String,
}

fn deadline() -> Deadline {
    Deadline::after(10_000).expect("a deadline builds")
}

fn children(connection: &Connection, bus: &str, path: &str) -> Vec<(String, String)> {
    let Ok(reply) = connection.call_method(
        Some(bus),
        path,
        Some(ACCESSIBLE_INTERFACE),
        "GetChildren",
        &(),
    ) else {
        return Vec::new();
    };
    reply
        .body()
        .deserialize::<Vec<(String, zbus::zvariant::OwnedObjectPath)>>()
        .map(|list| {
            list.into_iter()
                .map(|(bus, path)| (bus, path.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn entry(connection: &Connection, bus: &str, path: &str) -> Option<Entry> {
    let role = connection
        .call_method(Some(bus), path, Some(ACCESSIBLE_INTERFACE), "GetRole", &())
        .ok()?
        .body()
        .deserialize::<u32>()
        .ok()?;
    let name = connection
        .call_method(
            Some(bus),
            path,
            Some(PROPERTIES_INTERFACE),
            "Get",
            &(ACCESSIBLE_INTERFACE, "Name"),
        )
        .ok()
        .and_then(|reply| {
            reply
                .body()
                .deserialize::<zbus::zvariant::OwnedValue>()
                .ok()
        })
        .and_then(|value| String::try_from(value).ok())
        .unwrap_or_default();
    Some(Entry {
        bus: bus.to_owned(),
        path: path.to_owned(),
        role,
        name,
    })
}

fn pid_of(connection: &Connection, bus: &str) -> Option<u32> {
    connection
        .call_method(
            Some("org.freedesktop.DBus"),
            "/org/freedesktop/DBus",
            Some("org.freedesktop.DBus"),
            "GetConnectionUnixProcessID",
            &(bus,),
        )
        .ok()?
        .body()
        .deserialize::<u32>()
        .ok()
}

fn app_root(connection: &Connection, pid: u32) -> Option<(String, String)> {
    children(connection, REGISTRY_SERVICE, REGISTRY_ROOT_PATH)
        .into_iter()
        .find(|(bus, _)| pid_of(connection, bus) == Some(pid))
}

fn descendants(connection: &Connection, pid: u32) -> Vec<Entry> {
    let Some((bus, path)) = app_root(connection, pid) else {
        return Vec::new();
    };
    descendants_from(connection, children(connection, &bus, &path))
}

fn descendants_from(connection: &Connection, roots: Vec<(String, String)>) -> Vec<Entry> {
    let mut found = Vec::new();
    let mut stack: Vec<(String, String)> = roots.into_iter().rev().collect();
    while let Some((bus, path)) = stack.pop() {
        if found.len() >= NODE_LIMIT {
            break;
        }
        stack.extend(children(connection, &bus, &path).into_iter().rev());
        found.extend(entry(connection, &bus, &path));
    }
    found
}

fn do_action(connection: &Connection, target: &Entry) {
    let done = try_action(connection, target)
        .unwrap_or_else(|error| panic!("DoAction on {:?} failed: {error}", target.name));
    assert!(done);
}

fn try_action(connection: &Connection, target: &Entry) -> Result<bool, zbus::Error> {
    connection
        .call_method(
            Some(target.bus.as_str()),
            target.path.as_str(),
            Some(ACTION_INTERFACE),
            "DoAction",
            &(0_i32,),
        )
        .map(|reply| reply.body().deserialize::<bool>().unwrap_or(false))
}

struct AboutDialogCleanup<'a> {
    connection: &'a Connection,
    root: (String, String),
    before: Vec<(String, String)>,
}

fn showing(connection: &Connection, bus: &str, path: &str) -> bool {
    connection
        .call_method(Some(bus), path, Some(ACCESSIBLE_INTERFACE), "GetState", &())
        .ok()
        .and_then(|reply| reply.body().deserialize::<Vec<u32>>().ok())
        .is_some_and(|states| {
            states
                .first()
                .is_some_and(|bits| bits & (1 << STATE_SHOWING) != 0)
        })
}

impl AboutDialogCleanup<'_> {
    fn dismiss(&self) {
        let added = children(self.connection, &self.root.0, &self.root.1)
            .into_iter()
            .filter(|root| !self.before.contains(root))
            .filter(|(bus, path)| {
                showing(self.connection, bus, path)
                    && entry(self.connection, bus, path)
                        .is_some_and(|entry| entry.role == 16 && entry.name.starts_with("About"))
            })
            .collect();
        if let Some(close) = descendants_from(self.connection, added)
            .into_iter()
            .find(|entry| entry.role == MENU_BUTTON && entry.name == "Close")
        {
            let _ = try_action(self.connection, &close);
        }
    }
}

impl Drop for AboutDialogCleanup<'_> {
    fn drop(&mut self) {
        self.dismiss();
    }
}

fn poll<T>(what: &str, mut attempt: impl FnMut() -> Option<T>) -> T {
    let started = Instant::now();
    while started.elapsed() < SETTLE {
        if let Some(value) = attempt() {
            return value;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    panic!("{what} did not happen");
}

fn windows_of(bus: &SharedBus, pid: u32) -> Vec<WindowInfo> {
    let filter = WindowFilter {
        focused_only: false,
        app: None,
    };
    list_windows(bus, &filter, deadline())
        .unwrap_or_default()
        .into_iter()
        .filter(|window| window.pid == pid)
        .collect()
}

fn surfaces_of(bus: &SharedBus, identity: &ProcessIdentity) -> Vec<SurfaceInfo> {
    list_surfaces(bus, identity, deadline()).unwrap_or_default()
}

fn identity_of(bus: &SharedBus, pid: u32) -> ProcessIdentity {
    let app = poll("the app listing", || {
        app_inventory(bus, deadline())
            .ok()?
            .apps
            .into_iter()
            .find(|app| app.pid == pid)
    });
    ProcessIdentity::new(pid, app.process_instance.expect("an instance"))
}

fn sheets(surfaces: &[SurfaceInfo]) -> Vec<&SurfaceInfo> {
    surfaces
        .iter()
        .filter(|surface| surface.kind == "sheet")
        .collect()
}

fn require_new_sheet_window(bus: &SharedBus, pid: u32, identity: &ProcessIdentity, before: usize) {
    let surfaces = poll("a sheet surface", || {
        let surfaces = surfaces_of(bus, identity);
        (!sheets(&surfaces).is_empty()).then_some(surfaces)
    });
    let windows = windows_of(bus, pid);
    assert!(
        windows.len() > before,
        "the sheet window is listed beside the main window"
    );
    let sheet = sheets(&surfaces)[0];
    println!(
        "sheet_live sheet={:?} windows={:?}",
        sheet.title,
        windows.iter().map(|w| &w.title).collect::<Vec<_>>()
    );
    assert!(
        windows.iter().any(|window| window.id == sheet.id),
        "the sheet carries a listed window's id"
    );
}

fn open_gtk4_menu_item(connection: &Connection, pid: u32, from_end: usize) {
    let toggle = poll("the main menu button", || {
        let tree = descendants(connection, pid);
        let button = tree
            .iter()
            .position(|e| e.role == MENU_BUTTON && e.name == "Main Menu")?;
        tree.into_iter().skip(button).find(|e| e.role == TOGGLE)
    });
    do_action(connection, &toggle);
    let mut last = 0;
    let item = poll("the popover items", || {
        let items: Vec<Entry> = descendants(connection, pid)
            .into_iter()
            .filter(|e| e.role == MENU_ITEM)
            .collect();
        let settled = !items.is_empty() && items.len() == last;
        last = items.len();
        settled.then_some(items)
    });
    let target = item
        .into_iter()
        .rev()
        .nth(from_end - 1)
        .expect("the popover has enough items");
    do_action(connection, &target);
}

fn gtk4_case(from_end: usize) {
    let bus = SharedBus::default();
    let connection = bus.get(deadline()).expect("the accessibility bus");
    let mut launched = Launched::new();
    let pid = launched.spawn("gnome-calculator", &[]);
    let identity = identity_of(&bus, pid);
    let before = poll("the main window", || {
        let windows = windows_of(&bus, pid);
        (!windows.is_empty()).then_some(windows.len())
    });
    assert!(sheets(&surfaces_of(&bus, &identity)).is_empty());
    open_gtk4_menu_item(&connection, pid, from_end);
    require_new_sheet_window(&bus, pid, &identity, before);
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh"]
fn sheet_live_gtk4_about_is_a_modal_frame_sheet() {
    gtk4_case(1);
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh"]
fn sheet_live_gtk4_keyboard_shortcuts_is_a_modal_panel_window() {
    gtk4_case(3);
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh"]
fn sheet_live_gtk3_about_is_a_showing_dialog_sheet() {
    let bus = SharedBus::default();
    let connection = bus.get(deadline()).expect("the accessibility bus");
    let mut launched = Launched::new();
    launched.spawn("gnome-terminal", &[]);
    let (pid, before) = poll("the terminal window", || {
        let filter = WindowFilter {
            focused_only: false,
            app: Some("gnome-terminal-server".to_owned()),
        };
        let windows = list_windows(&bus, &filter, deadline()).ok()?;
        windows
            .first()
            .map(|window| (u32::from(window.pid), windows.len()))
    });
    let identity = identity_of(&bus, pid);
    assert!(sheets(&surfaces_of(&bus, &identity)).is_empty());
    let root = app_root(&connection, pid).expect("the terminal's accessibility root");
    let cleanup = AboutDialogCleanup {
        connection: &connection,
        before: children(&connection, &root.0, &root.1)
            .into_iter()
            .filter(|(bus, path)| showing(&connection, bus, path))
            .collect(),
        root,
    };
    let help = poll("the Help menu", || {
        descendants(&connection, pid)
            .into_iter()
            .find(|e| e.role == MENU && e.name == "Help")
    });
    do_action(&connection, &help);
    let about = poll("the About item", || {
        descendants(&connection, pid)
            .into_iter()
            .find(|e| e.role == MENU_ITEM && e.name.starts_with("About"))
    });
    do_action(&connection, &about);
    require_new_sheet_window(&bus, pid, &identity, before);
    cleanup.dismiss();
    poll("the About dialog to close", || {
        (sheets(&surfaces_of(&bus, &identity)).is_empty() && windows_of(&bus, pid).len() == before)
            .then_some(())
    });
}
