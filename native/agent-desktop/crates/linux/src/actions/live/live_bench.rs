use std::time::{Duration, Instant};

use agent_desktop_core::{
    Action, ActionRequest, ActionResult, AdapterError, Deadline, NativeHandle, ObservationOps,
    SystemOps, WindowFilter,
};
use zbus::zvariant::OwnedValue;

use crate::LinuxAdapter;
use crate::system::{PROPERTIES_INTERFACE, window::window_id, within};
use crate::tree::live::live_launch::{Launched, nonce};
use crate::tree::{AtspiElement, list_children, read_node};

use super::live_bench_env::qt_environment;
use super::live_text_scripts::{GTK3_SCRIPT, GTK4_SCRIPT, QT_SCRIPT};

const FRAME_SECONDS: u64 = 20;

#[derive(Clone, Copy, Debug)]
pub(in crate::actions) enum Toolkit {
    Gtk3,
    Gtk4,
    Qt,
}

pub(in crate::actions) const TOOLKITS: [Toolkit; 3] = [Toolkit::Gtk3, Toolkit::Gtk4, Toolkit::Qt];

pub(in crate::actions) struct Bench {
    adapter: LinuxAdapter,
    launched: Launched,
    frame: AtspiElement,
}

fn deadline(ms: u64) -> Deadline {
    Deadline::after(ms).expect("the deadline builds")
}

pub(in crate::actions) struct Scripts<'a> {
    pub(in crate::actions) gtk3: &'a str,
    pub(in crate::actions) gtk4: &'a str,
    pub(in crate::actions) qt: &'a str,
}

const TEXT_SCRIPTS: Scripts<'static> = Scripts {
    gtk3: GTK3_SCRIPT,
    gtk4: GTK4_SCRIPT,
    qt: QT_SCRIPT,
};

impl Bench {
    pub(in crate::actions) fn open(toolkit: Toolkit) -> Result<Self, String> {
        Self::open_scripts(toolkit, &TEXT_SCRIPTS)
    }

    pub(in crate::actions) fn attach(launched: Launched, frame: AtspiElement) -> Self {
        Self {
            adapter: LinuxAdapter::new(),
            launched,
            frame,
        }
    }

    pub(in crate::actions) fn open_scripts(
        toolkit: Toolkit,
        scripts: &Scripts<'_>,
    ) -> Result<Self, String> {
        let adapter = LinuxAdapter::new();
        let mut launched = Launched::new();
        let tag = nonce("value");
        let dir = std::env::temp_dir().join(&tag);
        std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        launched.scratch.push(dir.clone());
        let script = dir.join("app.py");
        let (program, source, environment) = match toolkit {
            Toolkit::Gtk3 => ("python3".to_owned(), scripts.gtk3, Vec::new()),
            Toolkit::Gtk4 => ("python3".to_owned(), scripts.gtk4, Vec::new()),
            Toolkit::Qt => {
                let (python, environment) = qt_environment();
                (python, scripts.qt, environment)
            }
        };
        std::fs::write(&script, source).map_err(|error| error.to_string())?;
        let script_arg = script.to_string_lossy().into_owned();
        let pid = launched.spawn_with_env(&program, &[&script_arg, &tag], &environment);
        let frame = Self::wait_for_frame(&adapter, &tag, pid, FRAME_SECONDS)?;
        Ok(Self {
            adapter,
            launched,
            frame,
        })
    }

    pub(in crate::actions) fn wait_for_frame(
        adapter: &LinuxAdapter,
        tag: &str,
        pid: u32,
        seconds: u64,
    ) -> Result<AtspiElement, String> {
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(seconds) {
            let windows = adapter
                .list_windows(&WindowFilter::default(), deadline(5_000))
                .unwrap_or_default();
            if let Some(window) = windows
                .iter()
                .find(|window| window.pid.get() == pid && window.title.contains(tag))
            {
                let (bus, path) = window_id::decode(&window.id).map_err(|e| e.message)?;
                return Ok(AtspiElement::new(bus, path, window.pid.get()));
            }
            if let Ok(connection) = adapter.bus().get(deadline(5_000))
                && let Some(frame) = super::live_click_tests::frame_of(&connection, pid)
            {
                return Ok(frame);
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        Err("the fixture window never appeared".to_owned())
    }

    fn walk_all(&self, matches: impl Fn(&crate::tree::RawNode) -> bool) -> Vec<AtspiElement> {
        let budget = deadline(10_000);
        let Ok(connection) = self.adapter.bus().get(budget) else {
            return Vec::new();
        };
        let mut root = self.frame.clone();
        root.set_ancestry(crate::tree::element::ancestry::of_root(&root));
        let mut queue = vec![root];
        let mut found = Vec::new();
        let mut index = 0;
        while index < queue.len() && index < 1500 {
            let element = queue[index].clone();
            index += 1;
            let Ok(node) = within(budget, read_node(connection.inner(), &element)) else {
                break;
            };
            if matches(&node) && index > 1 {
                found.push(element.clone());
            }
            let Ok(children) = within(budget, list_children(connection.inner(), &element)) else {
                break;
            };
            let role = node.traits.role.present().copied();
            queue.extend(children.into_iter().map(|(bus, path)| {
                let mut child = AtspiElement::new(bus, path, self.frame.pid());
                child.set_ancestry(crate::tree::element::ancestry::child(&element, role));
                child
            }));
        }
        found
    }

    fn walk(&self, matches: impl Fn(&crate::tree::RawNode) -> bool) -> Option<AtspiElement> {
        self.walk_all(matches).into_iter().next()
    }

    pub(in crate::actions) fn named(&self, name: &str) -> NativeHandle {
        let started = Instant::now();
        loop {
            let found = self.walk(|node| node.properties.name.present().is_some_and(|n| n == name));
            if let Some(element) = found {
                return element.into_native_handle();
            }
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "no node named {name}"
            );
            std::thread::sleep(Duration::from_millis(250));
        }
    }

    pub(in crate::actions) fn all_with_role(&self, role: u32) -> Vec<NativeHandle> {
        self.walk_all(|node| node.traits.role.present() == Some(&role))
            .into_iter()
            .map(AtspiElement::into_native_handle)
            .collect()
    }

    pub(in crate::actions) fn with_role(&self, role: u32) -> Option<NativeHandle> {
        self.walk(|node| node.traits.role.present() == Some(&role))
            .map(AtspiElement::into_native_handle)
    }

    pub(in crate::actions) fn act(
        &self,
        handle: &NativeHandle,
        action: Action,
    ) -> Result<ActionResult, AdapterError> {
        self.act_with(handle, ActionRequest::headless(action))
    }

    pub(in crate::actions) fn act_with(
        &self,
        handle: &NativeHandle,
        request: ActionRequest,
    ) -> Result<ActionResult, AdapterError> {
        let lease = SystemOps::acquire_interaction_lease(&self.adapter, deadline(30_000))?;
        crate::actions::execute_action(self.adapter.bus(), handle, request, &lease)
    }

    pub(in crate::actions) fn fixture_file(&self, name: &str) -> std::path::PathBuf {
        self.launched.scratch[0].join(name)
    }

    pub(in crate::actions) fn adapter(&self) -> &LinuxAdapter {
        &self.adapter
    }

    pub(in crate::actions) fn frame(&self) -> &AtspiElement {
        &self.frame
    }

    pub(in crate::actions) fn find(&self, role: u32, name: &str) -> Option<NativeHandle> {
        self.walk(|node| {
            node.traits.role.present() == Some(&role)
                && node.properties.name.present().is_some_and(|n| n == name)
        })
        .map(AtspiElement::into_native_handle)
    }

    pub(in crate::actions) fn raw_states(&self, handle: &NativeHandle) -> Vec<u32> {
        let element = crate::tree::atspi_element(handle).expect("an element");
        let budget = deadline(5_000);
        let connection = self.adapter.bus().get(budget).expect("the bus");
        within(budget, async {
            let reply = connection
                .inner()
                .call_method(
                    Some(element.bus_name()),
                    element.path(),
                    Some(crate::system::ACCESSIBLE_INTERFACE),
                    "GetState",
                    &(),
                )
                .await
                .map_err(|error| AdapterError::internal(error.to_string()))?;
            reply
                .body()
                .deserialize::<Vec<u32>>()
                .map_err(|error| AdapterError::internal(error.to_string()))
        })
        .expect("the state reads")
    }

    pub(in crate::actions) fn has_state(&self, handle: &NativeHandle, bit: u32) -> bool {
        crate::tree::vocabulary::state_bits::StateBits::new(&self.raw_states(handle)).has(bit)
    }

    pub(in crate::actions) fn action_names(&self, handle: &NativeHandle) -> Vec<String> {
        let element = crate::tree::atspi_element(handle).expect("an element");
        let budget = deadline(5_000);
        let connection = self.adapter.bus().get(budget).expect("the bus");
        within(budget, async {
            let reply = connection
                .inner()
                .call_method(
                    Some(element.bus_name()),
                    element.path(),
                    Some("org.a11y.atspi.Action"),
                    "GetActions",
                    &(),
                )
                .await
                .map_err(|error| AdapterError::internal(error.to_string()))?;
            reply
                .body()
                .deserialize::<Vec<(String, String, String)>>()
                .map(|actions| actions.into_iter().map(|(name, _, _)| name).collect())
                .map_err(|error| AdapterError::internal(error.to_string()))
        })
        .unwrap_or_default()
    }

    pub(in crate::actions) fn name_of(&self, handle: &NativeHandle) -> String {
        let value = self.property(handle, crate::system::ACCESSIBLE_INTERFACE, "Name");
        String::try_from(value).expect("a name")
    }

    pub(in crate::actions) fn add_selection(
        &self,
        handle: &NativeHandle,
        start: i32,
        end: i32,
    ) -> bool {
        let element = crate::tree::atspi_element(handle).expect("an element");
        let budget = deadline(5_000);
        let connection = self.adapter.bus().get(budget).expect("the bus");
        within(budget, async {
            let reply = connection
                .inner()
                .call_method(
                    Some(element.bus_name()),
                    element.path(),
                    Some("org.a11y.atspi.Text"),
                    "AddSelection",
                    &(start, end),
                )
                .await
                .map_err(|error| AdapterError::internal(error.to_string()))?;
            reply
                .body()
                .deserialize::<bool>()
                .map_err(|error| AdapterError::internal(error.to_string()))
        })
        .expect("the selection call answers")
    }

    pub(in crate::actions) fn wait_for<T>(&self, mut read: impl FnMut() -> Option<T>) -> Option<T> {
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(8) {
            if let Some(value) = read() {
                return Some(value);
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        None
    }

    fn property(&self, handle: &NativeHandle, interface: &str, name: &str) -> OwnedValue {
        let element = crate::tree::atspi_element(handle).expect("an element");
        let budget = deadline(5_000);
        let connection = self.adapter.bus().get(budget).expect("the bus");
        within(budget, async {
            let reply = connection
                .inner()
                .call_method(
                    Some(element.bus_name()),
                    element.path(),
                    Some(PROPERTIES_INTERFACE),
                    "Get",
                    &(interface, name),
                )
                .await
                .map_err(|error| AdapterError::internal(error.to_string()))?;
            reply
                .body()
                .deserialize::<OwnedValue>()
                .map_err(|error| AdapterError::internal(error.to_string()))
        })
        .expect("the property reads")
    }

    pub(in crate::actions) fn text_of(&self, handle: &NativeHandle) -> String {
        let element = crate::tree::atspi_element(handle).expect("an element");
        let count = self
            .property(handle, "org.a11y.atspi.Text", "CharacterCount")
            .downcast_ref::<i32>()
            .expect("a count");
        let budget = deadline(5_000);
        let connection = self.adapter.bus().get(budget).expect("the bus");
        within(budget, async {
            let reply = connection
                .inner()
                .call_method(
                    Some(element.bus_name()),
                    element.path(),
                    Some("org.a11y.atspi.Text"),
                    "GetText",
                    &(0i32, count),
                )
                .await
                .map_err(|error| AdapterError::internal(error.to_string()))?;
            reply
                .body()
                .deserialize::<String>()
                .map_err(|error| AdapterError::internal(error.to_string()))
        })
        .expect("the text reads")
    }

    pub(in crate::actions) fn maximum_of(&self, handle: &NativeHandle) -> f64 {
        self.property(handle, "org.a11y.atspi.Value", "MaximumValue")
            .downcast_ref::<f64>()
            .expect("a number")
    }

    pub(in crate::actions) fn number_of(&self, handle: &NativeHandle) -> f64 {
        self.property(handle, "org.a11y.atspi.Value", "CurrentValue")
            .downcast_ref::<f64>()
            .expect("a number")
    }
}

impl Drop for Bench {
    fn drop(&mut self) {
        self.launched.stop();
    }
}
