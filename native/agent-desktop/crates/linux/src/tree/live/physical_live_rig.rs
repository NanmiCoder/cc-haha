use std::time::{Duration, Instant};

use agent_desktop_core::{
    Action, ActionOps, ActionRequest, ActionResult, AdapterError, Deadline, InteractionLease,
    NativeHandle, ObservationOps, SystemOps,
};

use super::live_launch::{Launched, nonce};
use super::live_process::{is_running, process_report};
use super::live_rig::deadline;
use super::live_tree::pid_frame;
use super::resolve_live_tests::snapshot_entries;
use super::walker_live_tests::settle_watching;
use crate::LinuxAdapter;
use crate::input::x11::live_tests::private_display;
use crate::system::SharedBus;
use crate::system::window::window_id;
use crate::system::x11::stacking::stacking_source::StackingSource;
use crate::system::x11::{DisplayReader, X11Client, X11State};
use crate::tree::AtspiElement;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(in crate::tree) enum Kit {
    Gtk,
    Qt,
}

pub(in crate::tree) struct Scene {
    pub(in crate::tree) adapter: LinuxAdapter,
    pub(in crate::tree) bus: SharedBus,
    pub(in crate::tree) launched: Launched,
    pub(in crate::tree) frame: AtspiElement,
    pub(in crate::tree) log: String,
    pub(in crate::tree) pid: u32,
    pub(in crate::tree) client: X11Client,
}

fn qt_launch(launched: &mut Launched, script: &str, log: &str) -> u32 {
    let python = std::env::var("AGENT_DESKTOP_QT_PYTHON").unwrap_or_else(|_| "python3".to_owned());

    launched.spawn_with_env(
        &python,
        &[script],
        &[
            ("AD_LIVE_LOG", log.to_owned()),
            ("PYTHONUTF8", "1".to_owned()),
            ("QT_ACCESSIBILITY", "1".to_owned()),
            ("QT_LINUX_ACCESSIBILITY_ALWAYS_ON", "1".to_owned()),
            ("QT_QPA_PLATFORM", "xcb".to_owned()),
        ],
    )
}

pub(in crate::tree) fn write_script(source: &str) -> (String, String) {
    let dir = std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").expect("session");
    let tag = nonce("phys");
    let script = format!("{dir}/{tag}.py");
    std::fs::write(&script, source).expect("script");
    (script, format!("{dir}/{tag}.log"))
}

impl Scene {
    pub(in crate::tree) fn open(kit: Kit, source: &str, min_nodes: usize) -> Self {
        private_display();
        let (script, log) = write_script(source);
        let mut launched = Launched::new();
        let pid = match kit {
            Kit::Gtk => launched.spawn_with_env(
                "python3",
                &[&script],
                &[("AD_LIVE_LOG", log.clone()), ("PYTHONUTF8", "1".to_owned())],
            ),
            Kit::Qt => qt_launch(&mut launched, &script, &log),
        };
        Self::attach(launched, pid, log, min_nodes)
    }

    pub(in crate::tree) fn attach(
        mut launched: Launched,
        pid: u32,
        log: String,
        min_nodes: usize,
    ) -> Self {
        let adapter = LinuxAdapter::new();
        let bus = SharedBus::default();
        let connection = bus
            .get(Deadline::standard().expect("deadline"))
            .expect("the accessibility bus is reachable");
        let setup_started = Instant::now();
        let settled = settle_watching(&bus, min_nodes, Some(pid), || pid_frame(&connection, pid))
            .unwrap_or_else(|error| {
                launched.stop();
                panic!("{error}")
            });
        let ready = Deadline::from_duration(
            super::walker_live_tests::SETTLE_LIMIT.saturating_sub(setup_started.elapsed()),
        )
        .expect("setup budget");
        let id =
            window_id::encode(settled.frame.bus_name(), settled.frame.path()).expect("frame id");
        let client = loop {
            assert!(
                is_running(pid),
                "the fixture exited before its frame was mapped and listed: {}",
                process_report(pid)
            );
            assert!(
                !ready.is_expired(),
                "the fixture frame did not become mapped and listed within its setup budget: {}",
                process_report(pid)
            );
            if let X11State::Ready { clients, .. } = DisplayReader.clients_within(ready)
                && let Some(client) = clients.into_iter().find(|client| {
                    client.pid == Some(pid)
                        && !client.hidden
                        && client
                            .bounds
                            .is_some_and(|bounds| bounds.width > 0 && bounds.height > 0)
                })
                && adapter
                    .list_windows(&agent_desktop_core::WindowFilter::default(), ready)
                    .is_ok_and(|windows| windows.iter().any(|window| window.id == id))
            {
                break client;
            }
            std::thread::sleep(Duration::from_millis(100).min(ready.remaining()));
        };
        Self {
            adapter,
            bus,
            launched,
            frame: settled.frame,
            log,
            pid,
            client,
        }
    }

    pub(in crate::tree) fn find(&self, roles: &[&str], name: Option<&str>) -> NativeHandle {
        let entries = snapshot_entries(&self.adapter, &self.frame, true).expect("a snapshot");
        let entry = entries
            .iter()
            .find_map(|(_, entry)| {
                (roles.contains(&entry.identity.role.as_str())
                    && name.is_none_or(|wanted| entry.identity.name.as_deref() == Some(wanted)))
                .then_some(entry)
            })
            .unwrap_or_else(|| {
                let summary: Vec<String> = entries
                    .iter()
                    .map(|(_, entry)| format!("{}:{:?}", entry.identity.role, entry.identity.name))
                    .collect();
                panic!("no {roles:?} {name:?} among {summary:?}")
            });
        self.adapter
            .resolve_element_strict(entry, deadline(10_000))
            .expect("the entry resolves")
    }

    pub(in crate::tree) fn lease(&self) -> InteractionLease {
        self.adapter
            .acquire_interaction_lease(deadline(30_000))
            .expect("the lease")
    }

    pub(in crate::tree) fn act(
        &self,
        handle: &NativeHandle,
        action: Action,
    ) -> Result<ActionResult, AdapterError> {
        let lease = self.lease();
        self.adapter
            .execute_action(handle, ActionRequest::headed(action), &lease)
    }

    pub(in crate::tree) fn log_text(&self) -> String {
        std::fs::read_to_string(&self.log).unwrap_or_default()
    }

    pub(in crate::tree) fn wait_log(&self, done: impl Fn(&str) -> bool) -> String {
        let started = Instant::now();
        loop {
            let text = self.log_text();
            if done(&text) || started.elapsed() > Duration::from_secs(8) {
                return text;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    pub(in crate::tree) fn value_of(&self, target: &NativeHandle) -> Option<String> {
        self.adapter
            .get_live_value(target, deadline(5_000))
            .ok()
            .flatten()
    }
}

impl Drop for Scene {
    fn drop(&mut self) {
        self.launched.stop();
    }
}
