use std::collections::BTreeMap;

use agent_desktop_core::{AdapterError, ErrorCode};

use super::identity::ShellRoot;
use super::light::{Light, Nodes};
use crate::tree::vocabulary::role_numbers::{LABEL, PUSH_BUTTON, TOGGLE_BUTTON};
use crate::tree::{AtspiElement, Extents};

pub(super) const BUS: &str = ":1.7";
pub(super) const PID: u32 = 4242;
pub(super) const PANEL: u32 = 39;
pub(super) const MENU: u32 = 33;
pub(super) const WINDOW: u32 = 69;
pub(super) const SENTINEL: Extents = Extents {
    x: i32::MIN,
    y: i32::MIN,
    width: i32::MIN,
    height: i32::MIN,
};

pub(super) fn at(x: i32, y: i32, width: i32, height: i32) -> Extents {
    Extents {
        x,
        y,
        width,
        height,
    }
}

pub(super) fn element(path: &str) -> AtspiElement {
    AtspiElement::new(BUS, path, PID)
}

pub(super) struct FakeTree {
    nodes: BTreeMap<String, Light>,
    any_bus: bool,
}

impl FakeTree {
    pub(super) fn new() -> Self {
        Self {
            nodes: BTreeMap::new(),
            any_bus: false,
        }
    }

    pub(super) fn answering_on_any_bus(mut self) -> Self {
        self.any_bus = true;
        self
    }

    pub(super) fn add(
        &mut self,
        parent: Option<&str>,
        path: &str,
        role: u32,
        name: &str,
        extents: Extents,
    ) -> &mut Self {
        self.nodes.insert(
            path.to_owned(),
            Light {
                element: element(path),
                role,
                name: name.to_owned(),
                extents: Some(extents),
                showing: extents != SENTINEL,
                visible: true,
                children: Vec::new(),
            },
        );
        if let Some(parent) = parent {
            if let Some(node) = self.nodes.get_mut(parent) {
                node.children.push(element(path));
            }
        }
        self
    }

    pub(super) fn chain(&mut self, parent: &str, names: &[&str], extents: Extents) -> String {
        let mut above = parent.to_owned();
        for name in names {
            self.add(Some(&above), name, PANEL, "", extents);
            above = (*name).to_owned();
        }
        above
    }

    pub(super) fn hide(&mut self, path: &str) {
        if let Some(node) = self.nodes.get_mut(path) {
            node.showing = false;
        }
    }

    pub(super) fn vanish(&mut self, path: &str) {
        self.nodes.remove(path);
    }

    pub(super) fn root() -> ShellRoot {
        ShellRoot {
            bus_name: BUS.to_owned(),
            path: "/w".to_owned(),
            pid: PID,
        }
    }
}

impl Nodes for FakeTree {
    fn read(&self, element: &AtspiElement) -> Result<Light, AdapterError> {
        if !self.any_bus && element.bus_name() != BUS {
            return Err(AdapterError::new(ErrorCode::ElementNotFound, "gone"));
        }
        self.nodes
            .get(element.path())
            .cloned()
            .ok_or_else(|| AdapterError::new(ErrorCode::ElementNotFound, "unknown"))
    }
}

/// The measured shape of a GNOME Shell tree: an overview with copies of the
/// dash, the top bar with its three boxes, the calendar popup with the
/// message list and its footer, and the system menu popup.
pub(super) fn gnome_shell(list_open: bool, system_open: bool) -> FakeTree {
    let mut tree = FakeTree::new();
    for (parent, path, role, name, extents) in [
        (None, "/w", WINDOW, "", at(0, 54, 87, 55)),
        (Some("/w"), "/p2", PANEL, "", at(0, 0, 1280, 800)),
        (
            Some("/p2"),
            "/overview",
            PANEL,
            "Overview",
            at(0, 0, 1280, 800),
        ),
        (
            Some("/overview"),
            "/ov_clear",
            PUSH_BUTTON,
            "Clear all notifications",
            SENTINEL,
        ),
        (
            Some("/overview"),
            "/ov_apps",
            TOGGLE_BUTTON,
            "Show Apps",
            at(674, 704, 64, 72),
        ),
        (Some("/p2"), "/top", PANEL, "", at(0, 0, 1280, 32)),
        (Some("/top"), "/bar", PANEL, "", at(0, 0, 1280, 32)),
        (Some("/bar"), "/left", PANEL, "", at(0, 0, 72, 32)),
        (
            Some("/left"),
            "/activities",
            TOGGLE_BUTTON,
            "Activities",
            at(0, 0, 72, 32),
        ),
        (Some("/bar"), "/center", PANEL, "", at(569, 0, 142, 32)),
        (Some("/center"), "/date", MENU, "", at(569, 0, 142, 32)),
        (Some("/bar"), "/right", PANEL, "", at(1204, 0, 76, 32)),
        (Some("/right"), "/tray_wrap", PANEL, "", at(1204, 0, 0, 32)),
        (
            Some("/tray_wrap"),
            "/tray_item",
            MENU,
            "Dropbox",
            at(1204, 0, 24, 32),
        ),
        (Some("/right"), "/sys_wrap", PANEL, "", at(1204, 0, 76, 32)),
        (
            Some("/sys_wrap"),
            "/system",
            MENU,
            "System",
            at(1204, 0, 76, 32),
        ),
    ] {
        tree.add(parent, path, role, name, extents);
    }
    let (popup, clear, power) = ("/datepopup", "/clear", "/power");
    tree.add(Some("/p2"), popup, PANEL, "", at(277, 32, 726, 550));
    let list = tree.chain(
        popup,
        &["/d1", "/d2", "/d3", "/d4", "/listbox"],
        at(277, 32, 726, 550),
    );
    tree.add(Some(&list), "/list", PANEL, "", at(288, 49, 425, 522));
    tree.add(Some("/list"), "/scroller", PANEL, "", at(288, 49, 425, 474));
    tree.add(Some("/list"), "/footer", PANEL, "", at(288, 523, 425, 48));
    let shown = if list_open {
        at(615, 535, 86, 30)
    } else {
        SENTINEL
    };
    tree.add(
        Some("/footer"),
        "/dnd_label",
        LABEL,
        "",
        at(300, 530, 60, 20),
    );
    tree.add(
        Some("/footer"),
        "/dnd",
        TOGGLE_BUTTON,
        "",
        at(400, 530, 40, 20),
    );
    tree.add(
        Some("/footer"),
        clear,
        PUSH_BUTTON,
        "Clear all notifications",
        shown,
    );
    tree.add(Some("/p2"), "/layer", PANEL, "", at(0, 0, 0, 0));
    tree.add(Some("/layer"), "/syspop", PANEL, "", at(872, 32, 402, 202));
    let last = tree.chain(
        "/syspop",
        &["/s1", "/s2", "/s3", "/s4", "/s5"],
        at(872, 32, 402, 202),
    );
    let shown = if system_open {
        at(1217, 57, 38, 38)
    } else {
        SENTINEL
    };
    tree.add(Some(&last), power, PUSH_BUTTON, "Power Off Menu", shown);
    tree
}
