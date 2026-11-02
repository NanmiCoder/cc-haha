use std::process::Command;

use zbus::blocking::Connection;

use crate::system::{
    ACCESSIBLE_INTERFACE, PROPERTIES_INTERFACE, REGISTRY_ROOT_PATH, REGISTRY_SERVICE,
};

pub(crate) const MENU: u32 = 33;
pub(crate) const MENU_ITEM: u32 = 35;
pub(crate) const POPUP_MENU: u32 = 41;
pub(crate) const MENU_BUTTON: u32 = 43;
pub(crate) const TOGGLE: u32 = 62;
pub(crate) const STATE_CHECKED: u32 = 4;
pub(crate) const STATE_SHOWING: u32 = 25;
const ACTION_INTERFACE: &str = "org.a11y.atspi.Action";
const NODE_LIMIT: usize = 8000;

pub(crate) fn process_state(pid: u32) -> Option<char> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after_name = stat.rsplit_once(')')?.1;
    after_name.trim_start().chars().next()
}

pub(crate) fn process_gone(pid: u32) -> bool {
    matches!(process_state(pid), None | Some('Z' | 'X'))
}

fn xprop(args: &[&str]) -> String {
    let output = Command::new("xprop")
        .args(args)
        .output()
        .unwrap_or_else(|error| panic!("precondition: xprop did not run: {error}"));
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn hex_ids(text: &str) -> Vec<String> {
    text.split(|c: char| c == ',' || c.is_whitespace())
        .filter(|token| token.starts_with("0x"))
        .map(str::to_owned)
        .collect()
}

fn window_pid(id: &str) -> Option<u32> {
    xprop(&["-id", id, "_NET_WM_PID"])
        .rsplit('=')
        .next()?
        .trim()
        .parse()
        .ok()
}

pub(crate) fn x11_windows(pid: u32) -> Vec<String> {
    hex_ids(&xprop(&["-root", "_NET_CLIENT_LIST"]))
        .into_iter()
        .filter(|id| window_pid(id) == Some(pid))
        .collect()
}

pub(crate) struct Node {
    bus: String,
    path: String,
    pub(crate) role: u32,
    pub(crate) name: String,
    states: u64,
}

impl Node {
    pub(crate) fn has(&self, state: u32) -> bool {
        self.states & (1_u64 << state) != 0
    }
}

macro_rules! call {
    ($t:ty; $c:expr, $bus:expr, $path:expr, $iface:expr, $method:expr, $body:expr) => {
        $c.call_method(Some($bus), $path, Some($iface), $method, $body)
            .ok()
            .and_then(|reply| reply.body().deserialize::<$t>().ok())
    };
}

type Address = (String, zbus::zvariant::OwnedObjectPath);

fn children(c: &Connection, bus: &str, path: &str) -> Vec<(String, String)> {
    let list = call!(Vec<Address>; c, bus, path, ACCESSIBLE_INTERFACE, "GetChildren", &())
        .unwrap_or_default();
    list.into_iter().map(|(b, p)| (b, p.to_string())).collect()
}

fn read_node(c: &Connection, bus: &str, path: &str) -> Option<Node> {
    let role = call!(u32; c, bus, path, ACCESSIBLE_INTERFACE, "GetRole", &())?;
    let name_args = (ACCESSIBLE_INTERFACE, "Name");
    let name =
        call!(zbus::zvariant::OwnedValue; c, bus, path, PROPERTIES_INTERFACE, "Get", &name_args)
            .and_then(|value| String::try_from(value).ok())
            .unwrap_or_default();
    let words =
        call!(Vec<u32>; c, bus, path, ACCESSIBLE_INTERFACE, "GetState", &()).unwrap_or_default();
    let states = words
        .iter()
        .take(2)
        .enumerate()
        .fold(0_u64, |acc, (i, word)| acc | (u64::from(*word) << (32 * i)));
    let (bus, path) = (bus.to_owned(), path.to_owned());
    Some(Node {
        bus,
        path,
        role,
        name,
        states,
    })
}

fn app_roots(c: &Connection, pid: u32) -> Vec<(String, String)> {
    let bus_pid = |bus: &str| {
        let dbus = "org.freedesktop.DBus";
        let args = (bus,);
        call!(u32; c, dbus, "/org/freedesktop/DBus", dbus, "GetConnectionUnixProcessID", &args)
    };
    children(c, REGISTRY_SERVICE, REGISTRY_ROOT_PATH)
        .into_iter()
        .filter(|(bus, _)| bus_pid(bus) == Some(pid))
        .collect()
}

fn walk(c: &Connection, pid: u32, limit: usize, deep: bool) -> Vec<Node> {
    let mut found = Vec::new();
    let mut stack: Vec<(String, String)> = app_roots(c, pid)
        .iter()
        .flat_map(|(bus, path)| children(c, bus, path))
        .rev()
        .collect();
    while let Some((bus, path)) = stack.pop() {
        if found.len() >= limit {
            break;
        }
        if deep {
            stack.extend(children(c, &bus, &path).into_iter().rev());
        }
        found.extend(read_node(c, &bus, &path));
    }
    found
}

pub(crate) fn within(c: &Connection, root: &Node) -> Vec<Node> {
    let mut found = Vec::new();
    let mut stack = children(c, &root.bus, &root.path);
    while let Some((bus, path)) = stack.pop() {
        if found.len() >= NODE_LIMIT {
            break;
        }
        stack.extend(children(c, &bus, &path));
        found.extend(read_node(c, &bus, &path));
    }
    found
}

pub(crate) fn top_level(c: &Connection, pid: u32) -> Vec<Node> {
    walk(c, pid, usize::MAX, false)
}

pub(crate) fn descendants(c: &Connection, pid: u32) -> Vec<Node> {
    walk(c, pid, NODE_LIMIT, true)
}

pub(crate) fn showing_of(c: &Connection, pid: u32, roles: &[u32]) -> usize {
    let showing = |n: &&Node| roles.contains(&n.role) && n.has(STATE_SHOWING);
    descendants(c, pid).iter().filter(showing).count()
}

pub(crate) fn do_action(c: &Connection, target: &Node) {
    let done = call!(bool; c, target.bus.as_str(), target.path.as_str(), ACTION_INTERFACE, "DoAction", &(0_i32,));
    assert_eq!(
        done,
        Some(true),
        "DoAction on {:?} did not return true",
        target.name
    );
}
