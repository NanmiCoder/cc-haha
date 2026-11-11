use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use agent_desktop_core::{Deadline, InteractionLease, ObservationOps, RefEntry};

use super::live_scripts::SNI_FIXTURE;
use super::tray_item::TrayItem;
use super::view::TrayView;
use super::{TrayTarget, identity, read};
use crate::LinuxAdapter;
use crate::tree::live::test_support::ref_entry;

pub(super) fn deadline(ms: u64) -> Deadline {
    Deadline::after(ms).expect("a deadline builds")
}

pub(super) fn lease() -> InteractionLease {
    InteractionLease::guarded(deadline(10_000), ()).expect("a test lease builds")
}

pub(super) struct Rig {
    log: PathBuf,
    children: Vec<Child>,
    pub(super) adapter: LinuxAdapter,
}

impl Rig {
    pub(super) fn new(name: &str) -> Self {
        let log = std::env::temp_dir().join(format!("ad-tray-{name}-{}.log", std::process::id()));
        let _ = fs::remove_file(&log);
        Self {
            log,
            children: Vec::new(),
            adapter: LinuxAdapter::new(),
        }
    }

    pub(super) fn spawn(&mut self, args: &[&str]) -> usize {
        let needle = format!("ready {}", args[1]);
        let seen = self.count(&needle);
        let child = Command::new("python3")
            .arg("-c")
            .arg(SNI_FIXTURE)
            .args(args)
            .env("AD_TRAY_LOG", &self.log)
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("python3 starts the fixture");
        self.children.push(child);
        self.wait_for_nth(&needle, seen + 1);
        self.children.len() - 1
    }

    pub(super) fn log(&self) -> Vec<String> {
        fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    pub(super) fn count(&self, needle: &str) -> usize {
        self.log()
            .iter()
            .filter(|line| line.contains(needle))
            .count()
    }

    pub(super) fn wait_for(&self, needle: &str) {
        self.wait_for_nth(needle, 1);
    }

    pub(super) fn wait_for_nth(&self, needle: &str, times: usize) {
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(15) {
            if self.count(needle) >= times {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("the fixture never logged '{needle}': {:?}", self.log());
    }

    pub(super) fn signal(&self, child: usize, signal: &str) {
        let pid = self.children[child].id();
        let status = Command::new("kill")
            .args([signal, &pid.to_string()])
            .status()
            .expect("kill runs");
        assert!(status.success());
    }

    pub(super) fn stop(&mut self, child: usize) {
        let _ = self.children[child].kill();
        let _ = self.children[child].wait();
    }

    pub(super) fn view(&self) -> TrayView {
        read(deadline(10_000)).expect("the tray reads")
    }

    pub(super) fn entry_for(&self, target: &TrayTarget, role: &str, name: &str) -> RefEntry {
        let mut entry = ref_entry(role);
        entry.identity.name = Some(name.to_owned());
        entry.identity.native_id = Some(agent_desktop_core::ElementIdentifier {
            kind: agent_desktop_core::IdentifierKind::RuntimeId,
            value: identity::encode(target),
        });
        entry
    }

    pub(super) fn item_entry(&self, item: &TrayItem) -> RefEntry {
        self.entry_for(&item.target, "menubutton", &item.evidence.title)
    }

    pub(super) fn menu_entry(&self, item: &TrayItem, id: i32, labels: &[&str]) -> RefEntry {
        let menu = item.evidence.menu.as_deref().expect("the item has a menu");
        let labels: Vec<String> = labels.iter().map(|label| (*label).to_owned()).collect();
        let target = TrayTarget {
            menu_path: Some(menu.to_owned()),
            entry_id: Some(id),
            label_path: labels.clone(),
            ..item.target.clone()
        };
        let name = labels.last().cloned().unwrap_or_default();
        self.entry_for(&target, "menuitem", &name)
    }

    pub(super) fn resolve(
        &self,
        entry: &RefEntry,
    ) -> Result<agent_desktop_core::NativeHandle, agent_desktop_core::AdapterError> {
        self.adapter.resolve_element_strict(entry, deadline(10_000))
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        for child in &mut self.children {
            let _ = child.kill();
            let _ = child.wait();
        }
        let _ = fs::remove_file(&self.log);
    }
}
