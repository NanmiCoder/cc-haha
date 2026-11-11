use std::time::{Duration, Instant};

use agent_desktop_core::{AdapterError, Deadline, NativeHandle, ObservationOps, RefEntry};

use super::live_launch::Launched;
use super::live_tree::pid_frame;
use super::resolve_live_tests::snapshot_entries;
use super::walker_live_tests::{Settled, settle_watching};
use crate::LinuxAdapter;
use crate::system::{SharedBus, within};
use crate::tree::properties::node_read::call;
use crate::tree::{AtspiElement, atspi_element};

const ACTION_INTERFACE: &str = "org.a11y.atspi.Action";

/// The adapter and bus a live test drives, with the processes it launched.
pub(in crate::tree) struct Rig {
    pub(in crate::tree) adapter: LinuxAdapter,
    pub(in crate::tree) bus: SharedBus,
    pub(in crate::tree) launched: Launched,
}

pub(in crate::tree) fn rig() -> Rig {
    Rig {
        adapter: LinuxAdapter::new(),
        bus: SharedBus::default(),
        launched: Launched::new(),
    }
}

pub(in crate::tree) fn deadline(ms: u64) -> Deadline {
    Deadline::after(ms).expect("the deadline builds")
}

pub(in crate::tree) fn kind(error: &AdapterError) -> String {
    error
        .details
        .as_ref()
        .and_then(|details| details.get("kind"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

impl Rig {
    pub(in crate::tree) fn settled(&self, pid: u32, min_nodes: usize) -> Settled {
        let connection = self
            .bus
            .get(Deadline::standard().expect("a standard deadline builds"))
            .expect("the accessibility bus is reachable");
        settle_watching(&self.bus, min_nodes, Some(pid), || {
            pid_frame(&connection, pid)
        })
        .unwrap_or_else(|error| panic!("the app settles: {error}"))
    }

    pub(in crate::tree) fn entries(
        &self,
        frame: &AtspiElement,
        include_bounds: bool,
    ) -> Vec<(String, RefEntry)> {
        snapshot_entries(&self.adapter, frame, include_bounds).expect("a snapshot")
    }

    pub(in crate::tree) fn named(
        &self,
        frame: &AtspiElement,
        include_bounds: bool,
        name: &str,
    ) -> Vec<RefEntry> {
        self.entries(frame, include_bounds)
            .into_iter()
            .map(|(_, entry)| entry)
            .filter(|entry| entry.identity.name.as_deref() == Some(name))
            .collect()
    }

    pub(in crate::tree) fn resolve(&self, entry: &RefEntry) -> Result<NativeHandle, AdapterError> {
        self.adapter.resolve_element_strict(entry, deadline(5_000))
    }

    pub(in crate::tree) fn timed_resolve(
        &self,
        entry: &RefEntry,
    ) -> (Result<NativeHandle, AdapterError>, Duration) {
        let started = Instant::now();
        let outcome = self.resolve(entry);
        (outcome, started.elapsed())
    }

    pub(in crate::tree) fn do_action(
        &self,
        handle: &NativeHandle,
        index: i32,
    ) -> Result<(), AdapterError> {
        self.invoke(handle, ACTION_INTERFACE, "DoAction", index)
    }

    fn invoke(
        &self,
        handle: &NativeHandle,
        interface: &str,
        method: &str,
        index: i32,
    ) -> Result<(), AdapterError> {
        let element = atspi_element(handle)?;
        let budget = deadline(5_000);
        let connection = self.bus.get(budget)?;
        within(budget, async {
            call(connection.inner(), element, interface, method, &(index,))
                .await
                .map(|_| ())
                .map_err(|error| AdapterError::internal(error.to_string()))
        })
    }
}

pub(in crate::tree) fn wait_until(limit: Duration, mut condition: impl FnMut() -> bool) -> bool {
    let started = Instant::now();
    while started.elapsed() < limit {
        if condition() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

pub(in crate::tree) fn signal(pid: u32, name: &str) {
    let status = std::process::Command::new("kill")
        .args([&format!("-{name}"), &pid.to_string()])
        .status()
        .expect("kill runs");
    assert!(status.success(), "kill -{name} {pid} failed");
}

/// A process held stopped by SIGSTOP and continued again when this drops, so
/// a failing assertion cannot leave the fixture frozen.
pub(in crate::tree) struct Suspended(u32);

impl Suspended {
    pub(in crate::tree) fn new(pid: u32) -> Self {
        signal(pid, "STOP");
        Self(pid)
    }
}

impl Drop for Suspended {
    fn drop(&mut self) {
        let _ = std::process::Command::new("kill")
            .args(["-CONT", &self.0.to_string()])
            .status();
    }
}

pub(in crate::tree) fn refused<T>(outcome: Result<T, AdapterError>, what: &str) -> AdapterError {
    match outcome {
        Ok(_) => panic!("{what}"),
        Err(error) => error,
    }
}

/// Build a search probe without positional or exact-object shortcuts.
pub(in crate::tree) fn search_entry(entry: &RefEntry) -> RefEntry {
    let mut searched = entry.clone();
    searched.scope.path.clear();
    searched.identity.retained_object = None;
    searched
}
