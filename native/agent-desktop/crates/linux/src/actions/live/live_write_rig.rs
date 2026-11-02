use std::time::Duration;

use agent_desktop_core::{AdapterError, NativeHandle};
use zbus::blocking::Connection;
use zbus::zvariant::{OwnedObjectPath, OwnedValue};

use super::fixture::{deadline, wait_until};
use crate::actions::context::Target;
use crate::system::{SharedBus, owner_process_id};
use crate::tree::AtspiElement;
use crate::tree::live::live_process::{is_running, process_report};

pub(super) const ROLE_CHECK_BOX: u32 = 7;
pub(super) const ROLE_TOGGLE_BUTTON: u32 = 62;
pub(super) const ROLE_PROGRESS_BAR: u32 = 42;
pub(super) const ROLE_PUSH_BUTTON: u32 = 43;
const CHECKED: u32 = 4;
const PRESSED: u32 = 20;
const ACCESSIBLE: &str = "org.a11y.atspi.Accessible";
const REGISTRY: &str = "org.a11y.atspi.Registry";
const ROOT: &str = "/org/a11y/atspi/accessible/root";

pub(super) struct Probe {
    pub(super) bus: SharedBus,
    connection: Connection,
}

pub(super) fn probe() -> Probe {
    let bus = SharedBus::default();
    let connection = bus.get(deadline(10_000)).expect("the bus is reachable");
    Probe { bus, connection }
}

fn element_of(bus_name: &str, path: &OwnedObjectPath, pid: u32) -> AtspiElement {
    AtspiElement::new(bus_name, path.as_str(), pid)
}

impl Probe {
    fn call<B: zbus::export::serde::Serialize + zbus::zvariant::DynamicType>(
        &self,
        element: &AtspiElement,
        interface: &str,
        method: &str,
        body: &B,
    ) -> Result<zbus::Message, zbus::Error> {
        self.connection.call_method(
            Some(element.bus_name()),
            element.path(),
            Some(interface),
            method,
            body,
        )
    }

    fn property(&self, element: &AtspiElement, interface: &str, name: &str) -> Option<OwnedValue> {
        let reply = self
            .call(
                element,
                "org.freedesktop.DBus.Properties",
                "Get",
                &(interface, name),
            )
            .ok()?;
        reply.body().deserialize::<OwnedValue>().ok()
    }

    pub(super) fn children(&self, element: &AtspiElement) -> Vec<AtspiElement> {
        let Ok(reply) = self.call(element, ACCESSIBLE, "GetChildren", &()) else {
            return Vec::new();
        };
        let listed: Vec<(String, OwnedObjectPath)> = reply.body().deserialize().unwrap_or_default();
        listed
            .iter()
            .map(|(name, path)| element_of(name, path, element.pid()))
            .collect()
    }

    pub(super) fn name(&self, element: &AtspiElement) -> String {
        self.property(element, ACCESSIBLE, "Name")
            .and_then(|value| String::try_from(value).ok())
            .unwrap_or_default()
    }

    pub(super) fn role(&self, element: &AtspiElement) -> Option<u32> {
        let reply = self.call(element, ACCESSIBLE, "GetRole", &()).ok()?;
        reply.body().deserialize::<u32>().ok()
    }

    pub(super) fn action_names(&self, element: &AtspiElement) -> Vec<String> {
        let Ok(reply) = self.call(element, "org.a11y.atspi.Action", "GetActions", &()) else {
            return Vec::new();
        };
        let listed: Vec<(String, String, String)> = reply.body().deserialize().unwrap_or_default();
        listed.into_iter().map(|(name, _, _)| name).collect()
    }

    pub(super) fn toggle(&self, pid: u32) -> AtspiElement {
        self.find(pid, &|probe, element| {
            matches!(
                probe.role(element),
                Some(ROLE_CHECK_BOX | ROLE_TOGGLE_BUTTON)
            ) && probe.name(element) == "Flag"
        })
    }

    pub(super) fn checked(&self, element: &AtspiElement) -> Option<bool> {
        let reply = self.call(element, ACCESSIBLE, "GetState", &()).ok()?;
        let words = reply.body().deserialize::<Vec<u32>>().ok()?;
        Some(words.first()? & ((1 << CHECKED) | (1 << PRESSED)) != 0)
    }

    pub(super) fn value(&self, element: &AtspiElement) -> Option<f64> {
        self.property(element, "org.a11y.atspi.Value", "CurrentValue")
            .and_then(|value| f64::try_from(value).ok())
    }

    fn applications(&self, pid: u32) -> Vec<AtspiElement> {
        let root = AtspiElement::new(REGISTRY, ROOT, 0);
        self.children(&root)
            .iter()
            .filter(|app| {
                let owner =
                    zbus::block_on(owner_process_id(self.connection.inner(), app.bus_name()));
                owner.ok() == Some(pid)
            })
            .map(|app| AtspiElement::new(app.bus_name(), ROOT, pid))
            .collect()
    }

    fn descend(
        &self,
        element: &AtspiElement,
        depth: usize,
        matches: &dyn Fn(&Probe, &AtspiElement) -> bool,
    ) -> Option<AtspiElement> {
        if matches(self, element) {
            return Some(element.clone());
        }
        if depth == 0 {
            return None;
        }
        self.children(element)
            .iter()
            .find_map(|child| self.descend(child, depth - 1, matches))
    }

    fn dump(&self, pid: u32) -> String {
        let mut out = String::new();
        for app in self.applications(pid) {
            out.push_str(&format!(
                "root children call: {:?}\nChildCount: {:?}\n",
                self.call(&app, ACCESSIBLE, "GetChildren", &()).map(|m| m
                    .body()
                    .deserialize::<Vec<(String, OwnedObjectPath)>>()
                    .map_err(|e| e.to_string())),
                self.property(&app, ACCESSIBLE, "ChildCount")
            ));
            self.dump_into(&app, 0, &mut out);
        }
        out
    }

    fn dump_into(&self, element: &AtspiElement, depth: usize, out: &mut String) {
        out.push_str(&format!(
            "{}role={:?} name={:?}\n",
            "  ".repeat(depth),
            self.role(element),
            self.name(element)
        ));
        if depth < 10 {
            for child in self.children(element) {
                self.dump_into(&child, depth + 1, out);
            }
        }
    }

    pub(super) fn find(
        &self,
        pid: u32,
        matches: &dyn Fn(&Probe, &AtspiElement) -> bool,
    ) -> AtspiElement {
        let mut found = None;
        wait_until(Duration::from_secs(40), || {
            found = self
                .applications(pid)
                .iter()
                .find_map(|app| self.descend(app, 12, matches));
            found.is_some() || !is_running(pid)
        });
        assert!(
            found.is_some(),
            "the widget never appeared under pid {pid}; alive={}; {}; tree:\n{}",
            is_running(pid),
            process_report(pid),
            self.dump(pid)
        );
        found.expect("recorded")
    }

    pub(super) fn with_role(&self, pid: u32, role: u32, name: Option<&str>) -> AtspiElement {
        self.find(pid, &|probe, element| {
            probe.role(element) == Some(role)
                && name.is_none_or(|expected| probe.name(element) == expected)
        })
    }

    pub(super) fn framed(&self, pid: u32, element: &AtspiElement) -> AtspiElement {
        let app = self
            .applications(pid)
            .into_iter()
            .next()
            .expect("the application is on the bus");
        let mut frame = self.children(&app).into_iter().next().unwrap_or(app);
        frame.set_ancestry(crate::tree::element::ancestry::of_root(&frame));
        let mut framed = element.clone();
        framed.set_ancestry(crate::tree::element::ancestry::child(&frame, None));
        framed
    }

    pub(super) fn lists(&self, parent: &AtspiElement, child: &AtspiElement) -> bool {
        self.children(parent).iter().any(|item| item == child)
    }
}

pub(super) fn target<'a>(
    probe: &'a Probe,
    handle: &'a NativeHandle,
    element: &'a AtspiElement,
    budget_ms: u64,
) -> Target<'a> {
    Target {
        bus: &probe.bus,
        handle,
        element,
        deadline: deadline(budget_ms),
    }
}

pub(super) fn describe(error: &AdapterError) -> String {
    format!(
        "{:?} delivery={:?} retry={:?} detail={:?}",
        error.code,
        error.disposition.delivery(),
        error.disposition.retry(),
        error.platform_detail
    )
}
