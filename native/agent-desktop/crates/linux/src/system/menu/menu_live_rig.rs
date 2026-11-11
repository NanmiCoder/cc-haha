use std::process::Command;
use std::time::{Duration, Instant};

use agent_desktop_core::{
    AdapterError, Deadline, ErrorCode, ObservationOps, ProcessIdentity, RefEntry, SnapshotSurface,
    SurfaceInfo, TreeOptions, WindowFilter, WindowInfo, snapshot,
};
use zbus::blocking::Connection;

use crate::LinuxAdapter;
use crate::system::{
    ACCESSIBLE_INTERFACE, REGISTRY_ROOT_PATH, REGISTRY_SERVICE, SharedBus, app_inventory,
    list_surfaces, list_windows,
};
use crate::tree::{AtspiElement, atspi_element};

const ACTION_INTERFACE: &str = "org.a11y.atspi.Action";
const ITEM_ROLES: [u32; 3] = [35, 8, 45];
const MENU_ROLES: [u32; 2] = [33, 41];
const SHOWING_BIT: u32 = 25;
const NODE_LIMIT: usize = 6000;

pub(in crate::system) struct Rig {
    pub(in crate::system) bus: SharedBus,
    pub(in crate::system) adapter: LinuxAdapter,
    pub(in crate::system) connection: Connection,
    pub(in crate::system) pid: u32,
    pub(in crate::system) identity: ProcessIdentity,
}

pub(in crate::system) fn deadline() -> Deadline {
    Deadline::after(15_000).expect("a deadline builds")
}

pub(in crate::system) fn poll<T>(what: &str, mut attempt: impl FnMut() -> Option<T>) -> T {
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(40) {
        if let Some(value) = attempt() {
            return value;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    panic!("{what} did not happen");
}

pub(in crate::system) fn tool(program: &str, args: &[&str]) -> String {
    let output = Command::new(program)
        .args(args)
        .output()
        .unwrap_or_else(|error| panic!("{program} did not run: {error}"));
    String::from_utf8_lossy(&output.stdout).into_owned()
}

pub(in crate::system) fn right_click(x: i32, y: i32) {
    tool("xdotool", &["mousemove", &x.to_string(), &y.to_string()]);
    std::thread::sleep(Duration::from_millis(200));
    tool("xdotool", &["click", "3"]);
}

pub(in crate::system) fn press_escape() {
    tool("xdotool", &["key", "Escape"]);
}

impl Rig {
    pub(in crate::system) fn attach(pid: u32) -> Self {
        let bus = SharedBus::default();
        let connection = bus.get(deadline()).expect("the accessibility bus");
        let app = poll("the app listing", || {
            app_inventory(&bus, deadline())
                .ok()?
                .apps
                .into_iter()
                .find(|app| app.pid == pid)
        });
        let identity = ProcessIdentity::new(pid, app.process_instance.expect("an instance"));
        Self {
            bus,
            adapter: LinuxAdapter::new(),
            connection,
            pid,
            identity,
        }
    }

    pub(in crate::system) fn window(&self) -> WindowInfo {
        poll("a window", || {
            let filter = WindowFilter {
                focused_only: false,
                app: None,
            };
            list_windows(&self.bus, &filter, deadline())
                .ok()?
                .into_iter()
                .find(|window| window.pid == self.pid)
        })
    }

    pub(in crate::system) fn surfaces(&self) -> Vec<SurfaceInfo> {
        list_surfaces(&self.bus, &self.identity, deadline()).unwrap_or_default()
    }

    pub(in crate::system) fn menu_surface(&self) -> Option<SurfaceInfo> {
        self.surfaces()
            .into_iter()
            .find(|surface| surface.kind == "menu")
    }

    pub(in crate::system) fn menu_entries(
        &self,
        window: &WindowInfo,
    ) -> Result<Vec<(String, RefEntry)>, String> {
        let options = TreeOptions {
            include_bounds: true,
            surface: SnapshotSurface::Menu,
            ..TreeOptions::default()
        };
        let result = snapshot::build(&self.adapter, &options, None, Some(&window.id), deadline())
            .map_err(|error| error.to_string())?;
        let value = serde_json::to_value(&result.refmap).expect("a refmap serializes");
        let inner = value["inner"].as_object().expect("entries");
        Ok(inner
            .iter()
            .map(|(id, entry)| {
                (
                    id.clone(),
                    serde_json::from_value(entry.clone()).expect("an entry"),
                )
            })
            .collect())
    }

    pub(in crate::system) fn window_entry(
        &self,
        window: &WindowInfo,
        role: &str,
        name: &str,
    ) -> Option<RefEntry> {
        let options = TreeOptions {
            include_bounds: true,
            ..TreeOptions::default()
        };
        let result =
            snapshot::build(&self.adapter, &options, None, Some(&window.id), deadline()).ok()?;
        let value = serde_json::to_value(&result.refmap).ok()?;
        value["inner"]
            .as_object()?
            .values()
            .filter_map(|entry| serde_json::from_value::<RefEntry>(entry.clone()).ok())
            .find(|entry| {
                entry.identity.role == role && entry.identity.name.as_deref() == Some(name)
            })
    }

    pub(in crate::system) fn raw_find(&self, roles: &[u32], name: &str) -> Option<AtspiElement> {
        let (bus, path) = self.app_root()?;
        let mut stack = vec![(bus, path)];
        let mut seen = 0;
        while let Some((bus, path)) = stack.pop() {
            seen += 1;
            if seen > NODE_LIMIT {
                break;
            }
            if self
                .role(&bus, &path)
                .is_some_and(|role| roles.contains(&role))
                && self.name(&bus, &path) == name
            {
                return Some(AtspiElement::new(bus, path, self.pid));
            }
            stack.extend(self.children(&bus, &path));
        }
        None
    }

    fn name(&self, bus: &str, path: &str) -> String {
        self.connection
            .call_method(
                Some(bus),
                path,
                Some(crate::system::PROPERTIES_INTERFACE),
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
            .unwrap_or_default()
    }

    pub(in crate::system) fn resolve(
        &self,
        entry: &RefEntry,
    ) -> Result<AtspiElement, AdapterError> {
        let handle = self.adapter.resolve_element_strict(entry, deadline())?;
        Ok(atspi_element(&handle).expect("an element").clone())
    }

    pub(in crate::system) fn do_action(&self, element: &AtspiElement) {
        let reply = self
            .connection
            .call_method(
                Some(element.bus_name()),
                element.path(),
                Some(ACTION_INTERFACE),
                "DoAction",
                &(0_i32,),
            )
            .expect("DoAction answers");
        assert!(reply.body().deserialize::<bool>().unwrap_or(false));
    }

    pub(in crate::system) fn open_item_count(&self) -> usize {
        let Some((bus, path)) = self.app_root() else {
            return 0;
        };
        let mut count = 0;
        let mut stack = vec![(bus, path, false)];
        let mut seen = 0;
        while let Some((bus, path, in_menu)) = stack.pop() {
            seen += 1;
            if seen > NODE_LIMIT {
                break;
            }
            let role = self.role(&bus, &path).unwrap_or(0);
            let showing = self.showing(&bus, &path);
            if in_menu && showing && ITEM_ROLES.contains(&role) {
                count += 1;
            }
            let menu = in_menu || (MENU_ROLES.contains(&role) && showing);
            for (child_bus, child_path) in self.children(&bus, &path) {
                stack.push((child_bus, child_path, menu));
            }
        }
        count
    }

    pub(in crate::system) fn text_selection_count(&self) -> i32 {
        let Some((bus, path)) = self.app_root() else {
            return 0;
        };
        let mut total = 0;
        let mut stack = vec![(bus, path)];
        let mut seen = 0;
        while let Some((bus, path)) = stack.pop() {
            seen += 1;
            if seen > NODE_LIMIT {
                break;
            }
            let selections = self
                .connection
                .call_method(
                    Some(bus.as_str()),
                    path.as_str(),
                    Some("org.a11y.atspi.Text"),
                    "GetNSelections",
                    &(),
                )
                .ok()
                .and_then(|reply| reply.body().deserialize::<i32>().ok());
            total += selections.unwrap_or(0);
            stack.extend(self.children(&bus, &path));
        }
        total
    }

    fn app_root(&self) -> Option<(String, String)> {
        self.children(REGISTRY_SERVICE, REGISTRY_ROOT_PATH)
            .into_iter()
            .find(|(bus, _)| {
                self.pid_of(bus) == Some(self.pid)
                    && !self.children(bus, REGISTRY_ROOT_PATH).is_empty()
            })
    }

    fn pid_of(&self, bus: &str) -> Option<u32> {
        self.connection
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

    fn children(&self, bus: &str, path: &str) -> Vec<(String, String)> {
        let Ok(reply) = self.connection.call_method(
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
            .map(|list| list.into_iter().map(|(b, p)| (b, p.to_string())).collect())
            .unwrap_or_default()
    }

    fn role(&self, bus: &str, path: &str) -> Option<u32> {
        self.connection
            .call_method(Some(bus), path, Some(ACCESSIBLE_INTERFACE), "GetRole", &())
            .ok()?
            .body()
            .deserialize::<u32>()
            .ok()
    }

    fn showing(&self, bus: &str, path: &str) -> bool {
        self.connection
            .call_method(Some(bus), path, Some(ACCESSIBLE_INTERFACE), "GetState", &())
            .ok()
            .and_then(|reply| reply.body().deserialize::<Vec<u32>>().ok())
            .is_some_and(|words| {
                words
                    .first()
                    .is_some_and(|word| word & (1 << SHOWING_BIT) != 0)
            })
    }
}

pub(in crate::system) fn is_closed_ref(error: &AdapterError) -> bool {
    error.code == ErrorCode::StaleRef
        && error
            .details
            .as_ref()
            .and_then(|details| details.get("kind"))
            .and_then(serde_json::Value::as_str)
            == Some("menu_closed")
}
