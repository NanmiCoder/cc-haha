use std::path::PathBuf;

use super::runtime_store::{named_stem, runtime_subdir, write_private_atomically};

const NAMES_DIR: &str = "agent-desktop-app-names";

/// The name each application's accessibility root answered to, kept per bus
/// name and process instance in a private directory of the runtime dir. A
/// stopped process cannot be asked, so the name it resolved by while it
/// answered is read back from here.
pub(in crate::system) struct AppNames {
    dir: PathBuf,
}

impl AppNames {
    pub(in crate::system) fn in_runtime_dir() -> Option<Self> {
        runtime_subdir(NAMES_DIR).map(|dir| Self { dir })
    }

    fn path(&self, bus_name: &str, instance: &str) -> PathBuf {
        self.dir.join(named_stem(bus_name, instance))
    }

    pub(in crate::system) fn remember(&self, bus_name: &str, instance: &str, name: &str) {
        let path = self.path(bus_name, instance);
        if std::fs::read_to_string(&path).is_ok_and(|known| known == name) {
            return;
        }
        let _ = write_private_atomically(&self.dir, &path, name.as_bytes());
    }

    pub(in crate::system) fn recall(&self, bus_name: &str, instance: &str) -> Option<String> {
        std::fs::read_to_string(self.path(bus_name, instance))
            .ok()
            .filter(|name| !name.is_empty())
    }
}

#[cfg(test)]
#[path = "app_names_tests.rs"]
mod tests;
